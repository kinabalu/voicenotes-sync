import { App, DataAdapter, Editor, moment, normalizePath, Notice, Plugin, PluginManifest, TFile, } from 'obsidian';
import VoiceNotesApi from "./voicenotes-api";
import { capitalizeFirstLetter, getFilenameFromUrl, isToday } from "./utils";
import { VoiceNoteEmail, VoiceNotesPluginSettings } from "./types";
import { sanitize } from 'sanitize-filename-ts';
import { VoiceNotesSettingTab } from "./settings";

const DEFAULT_SETTINGS: VoiceNotesPluginSettings = {
	automaticSync: true,
	syncTimeout: 60,
	downloadAudio: false,
	replaceTranscriptWithTidy: true,
	syncDirectory: "voicenotes",
	deleteSynced: false,
	reallyDeleteSynced: false,
	todoTag: "",
	prependDateToTitle: false,
	prependDateFormat: "YYYY-MM-DD"
}

export default class VoiceNotesPlugin extends Plugin {
	settings: VoiceNotesPluginSettings;
	vnApi: VoiceNotesApi;
	fs: DataAdapter;
	syncInterval: number;
	timeSinceSync: number = 0;

	syncedRecordingIds: number[];

	ONE_SECOND = 1000;

	constructor(app: App, manifest: PluginManifest) {
		super(app, manifest)
		this.fs = app.vault.adapter
	}

	async onload() {
		window.clearInterval(this.syncInterval)

		await this.loadSettings();
		this.addSettingTab(new VoiceNotesSettingTab(this.app, this));


		this.addCommand({
			id: 'manual-sync-voicenotes',
			name: 'Manual Sync Voicenotes',
			callback: async () => await this.sync(false)
		})

		this.addCommand({
			id: 'insert-voicenotes-from-today',
			name: 'Insert Today\'s Voicenotes',
			editorCallback: async (editor: Editor) => {
				if (!this.settings.token) {
					new Notice('No access available, please login in plugin settings')
					return
				}

				const todaysRecordings = await this.getTodaysSyncedRecordings()

				if (todaysRecordings.length === 0) {
					new Notice("No recordings from today found")
					return
				}

				let listOfToday = todaysRecordings.map(filename => `- [[${filename}]]`).join('\n')
				editor.replaceSelection(listOfToday)
			}
		});

		this.registerEvent(this.app.metadataCache.on("deleted", (deletedFile, prevCache) => {
			if (prevCache.frontmatter?.recording_id) {
				this.syncedRecordingIds.remove(prevCache.frontmatter?.recording_id);
			}
		}));

		this.syncedRecordingIds = await this.getSyncedRecordingIds();
		await this.sync(this.syncedRecordingIds.length === 0);
	}

	onunload() {
		this.syncedRecordingIds = []
		window.clearInterval(this.syncInterval)
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async getRecordingIdFromFile(file: TFile): Promise<number | undefined> {
		return this.app.metadataCache.getFileCache(file)?.frontmatter?.['recording_id'];
	}

	async isRecordingFromToday(file: TFile): Promise<boolean> {
		return isToday(await this.app.metadataCache.getFileCache(file)?.frontmatter?.['created_at']);
	}

	sanitizedTitle(title: string, created_at: string): string {
		let generatedTitle = this.settings.prependDateToTitle ? `${moment(created_at).format(this.settings.prependDateFormat)} ${title}` : title
		return sanitize(generatedTitle)
	}

	/**
	 * Return the recording IDs that we've already synced
	 */
	async getSyncedRecordingIds(): Promise<number[]> {
		const { vault } = this.app;

		const markdownFiles = vault.getMarkdownFiles().filter(file => file.path.startsWith(this.settings.syncDirectory));

		return (await Promise.all(
			markdownFiles.map(async (file) => this.getRecordingIdFromFile(file))
		)).filter(recordingId => recordingId !== undefined) as number[];
	}

	async getTodaysSyncedRecordings(): Promise<string[]> {
		const { vault } = this.app;

		const markdownFiles = vault.getMarkdownFiles().filter(file => file.path.startsWith(this.settings.syncDirectory));

		return (await Promise.all(
			markdownFiles.map(async (file) => await this.isRecordingFromToday(file) ? file.basename : undefined)
		)).filter(filename => filename !== undefined) as string[];
	}

	async processNote(recording: any, voiceNotesDir: string, isSubnote: boolean = false): Promise<void> {
		if (!recording.title) {
			new Notice(`Unable to grab voice recording with id: ${recording.id}`);
			return;
		}

		if (this.syncedRecordingIds.includes(recording.recording_id)) {
			return;
		}

		const title = this.sanitizedTitle(recording.title, recording.created_at);
		const recordingPath = normalizePath(`${voiceNotesDir}/${title}.md`);

		let note = '---\n';
		note += `recording_id: ${recording.recording_id}\n`;
		note += `duration: ${Math.floor(recording.duration / 60000) > 0
			? `${Math.floor(recording.duration / 60000)}m`
			: ''
			}${Math.floor((recording.duration % 60000) / 1000).toString().padStart(2, '0')}s\n`;
		note += `created_at: ${recording.created_at}\n`;
		note += `updated_at: ${recording.updated_at}\n`;

		if (recording.tags && recording.tags.length > 0) {
			note += `tags: ${recording.tags.map((tag: { name: string }) => tag.name).join(",")}\n`;
		}
		note += '---\n';

		if (this.settings.downloadAudio) {
			const audioPath = normalizePath(`${voiceNotesDir}/audio`);

			if (!await this.app.vault.adapter.exists(audioPath)) {
				await this.app.vault.createFolder(audioPath);
			}
			const outputLocationPath = normalizePath(`${audioPath}/${recording.recording_id}.mp3`);

			if (!await this.app.vault.adapter.exists(outputLocationPath)) {
				const signedUrl = await this.vnApi.getSignedUrl(recording.recording_id);
				await this.vnApi.downloadFile(this.fs, signedUrl.url, outputLocationPath);
			}

			note += `![[${recording.recording_id}.mp3]]\n\n`;
		}

		const summary = recording.creations.find((creation: { type: string }) => creation.type === 'summary');
		const points = recording.creations.find((creation: { type: string }) => creation.type === 'points');
		if (summary) {
			note += '# Summary\n\n' + (summary.content.data as string) + '\n\n';
		}
		if (points) {
			note += '# Key Points\n\n' + (points.content.data as string) + '\n\n';
		}
		if (recording.transcript) {
			const tidyTranscript = recording.creations.find((creation: { type: string }) => creation.type === 'tidy');
			if (this.settings.replaceTranscriptWithTidy && tidyTranscript) {
				note += '# Tidy Transcript\n\n' + tidyTranscript.content.data + '\n\n';
			} else {
				note += '# Transcript\n\n' + recording.transcript + '\n\n';
			}
		}

		for (const creation of recording.creations) {
			if (creation.type === 'summary' || creation.type === 'points' || (creation.type === 'tidy' && this.settings.replaceTranscriptWithTidy)) {
				continue;
			}

			note += `## ${capitalizeFirstLetter(creation.type)}\n\n`;

			if (creation.type === 'email') {
				const creationData = creation.content.data as VoiceNoteEmail;
				note += `**Subject:** ${creationData.subject}\n\n`;
				note += `${creationData.body}\n`;
			} else if (creation.type === 'todo') {
				const creationData = creation.content.data as string[];

				if (Array.isArray(creationData)) {
					note += creationData.map(data => `- [ ] ${data}${this.settings.todoTag ? ' #' + this.settings.todoTag : ''}`).join('\n');
				}
			} else {
				const creationData = creation.content.data as string;
				note += creationData;
				note += '\n';
			}
		}

		if (recording.attachments && recording.attachments.length > 0) {
			note += '\n## Attachments\n';
			note += (await Promise.all(recording.attachments.map(async (data: { type: number, description?: string, url?: string }) => {
				if (data.type === 1) {
					return `- ${data.description}`;
				} else if (data.type === 2) {
					const attachmentsPath = normalizePath(`${voiceNotesDir}/attachments`);

					if (!await this.app.vault.adapter.exists(attachmentsPath)) {
						await this.app.vault.createFolder(attachmentsPath);
					}

					const filename = getFilenameFromUrl(data.url);
					const attachmentPath = normalizePath(`${attachmentsPath}/${filename}`);
					await this.vnApi.downloadFile(this.fs, data.url, attachmentPath);
					return `- ![[${filename}]]`;
				}
			}))).join('\n');
			note += '\n';
		}

		if (!isSubnote) {
			if (recording.related_notes && recording.related_notes.length > 0) {
				note += '\n## Related Notes\n\n';
				note += recording.related_notes.map((relatedNote: { title: string; created_at: string }) => `- [[${this.sanitizedTitle(relatedNote.title, relatedNote.created_at)}]]`).join('\n');
			}

			if (recording.subnotes && recording.subnotes.length > 0) {
				note += '\n### Subnotes\n\n';
				for (const subnote of recording.subnotes) {
					await this.processNote(subnote, voiceNotesDir, true);
					note += `- [[${this.sanitizedTitle(subnote.title, subnote.created_at)}]]\n`;
				}
			}
		}

		if (await this.app.vault.adapter.exists(recordingPath)) {
			await this.app.vault.modify(this.app.vault.getFileByPath(recordingPath), note);
		} else {
			await this.app.vault.create(recordingPath, note);
		}

		this.syncedRecordingIds.push(recording.recording_id);

		// DESTRUCTIVE action which will delete all synced recordings from server if turned on
		// We ask twice to make sure user is doubly sure
		if (this.settings.deleteSynced && this.settings.reallyDeleteSynced) {
			await this.vnApi.deleteRecording(recording.recording_id)
		}
	}

	async sync(fullSync: boolean = false) {
		console.debug(`Sync running full? ${fullSync}`)

		this.vnApi = new VoiceNotesApi({});
		this.vnApi.token = this.settings.token

		const voiceNotesDir = normalizePath(this.settings.syncDirectory)
		if (!await this.app.vault.adapter.exists(voiceNotesDir)) {
			new Notice("Creating sync directory for Voice Notes Sync plugin")
			await this.app.vault.createFolder(voiceNotesDir)
		}

		let recordings = await this.vnApi.getRecordings()

		if (fullSync && recordings.links.next) {
			let nextPage = recordings.links.next

			do {
				console.debug(`Performing a full sync ${nextPage}`)

				let moreRecordings = await this.vnApi.getRecordingsFromLink(nextPage)
				recordings.data.push(...moreRecordings.data);
				nextPage = moreRecordings.links.next;
			} while (nextPage)
		}

		if (recordings) {
			new Notice(`Syncing latest Voicenotes`)
			for (const recording of recordings.data) {
				await this.processNote(recording, voiceNotesDir);
			}
		}

		window.clearInterval(this.syncInterval)

		if (this.settings.automaticSync) {
			console.debug(`timeSinceSync ${this.timeSinceSync} - syncTimeout: ${this.settings.syncTimeout}`)
			this.syncInterval = window.setInterval(() => {
				this.timeSinceSync += this.ONE_SECOND

				if (this.timeSinceSync >= this.settings.syncTimeout * 60 * 1000) {
					this.timeSinceSync = 0
					this.sync()
					// this.sync(fullSync = false)
				}
			}, this.ONE_SECOND)
		}

	}
}

