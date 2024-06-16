import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	PluginManifest,
	DataAdapter,
	normalizePath, TFile, Editor,
} from 'obsidian';
import {moment} from "obsidian"
import VoiceNotesApi from "./voicenotes-api";
import {capitalizeFirstLetter, isToday} from "./utils";
import {VoiceNoteEmail} from "./types";
import { sanitize } from 'sanitize-filename-ts';

declare global {
	interface Window {
		moment: typeof moment;
	}
}

interface VoiceNotesPluginSettings {
	token?: string;
	username?: string;
	password?: string;
	syncTimeout?: number;
	downloadAudio?: boolean;
	syncDirectory: string;
	deleteSynced: boolean;
	reallyDeleteSynced: boolean;
	todoTag: string;
	prependDateToTitle: boolean;
	prependDateFormat: string;
}

const DEFAULT_SETTINGS: VoiceNotesPluginSettings = {
	syncTimeout: 60,
	downloadAudio: false,
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
	syncInterval : number;
	timeSinceSync : number = 0;

	syncedRecordingIds : number[];

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

	async getRecordingIdFromFile(file: TFile) : Promise<number | undefined> {
		return this.app.metadataCache.getFileCache(file)?.frontmatter?.['recording_id'];
	}

	async isRecordingFromToday(file: TFile) : Promise<boolean> {
		return isToday(await this.app.metadataCache.getFileCache(file)?.frontmatter?.['created_at']);
	}

	sanitizedTitle(title: string, created_at: string) : string {
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

	async sync(fullSync: boolean = false) {
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
			} while(nextPage)
		}

		// console.dir(recordings)
		if (recordings) {
			for (const recording of recordings.data) {
				if (!recording.title) {
					new Notice(`Unable to grab voice recording with id: ${recording.id}`)
					continue
				}

				// If we've already synced it locally let's not do it again
				if (this.syncedRecordingIds.includes(recording.recording_id)) {
					continue;
				}

				const title = this.sanitizedTitle(recording.title, recording.created_at)
				const recordingPath = normalizePath(`${voiceNotesDir}/${title}.md`)

				let note = '---\n'
				note += `recording_id: ${recording.recording_id}\n`
				note += `duration: ${recording.duration}\n`
        note += `created_at: ${recording.created_at}\n`
        note += `updated_at: ${recording.updated_at}\n`

				if (recording.tags.length > 0) {
					note += `tags: ${recording.tags.map(tag => tag.name).join(",")}\n`
				}
				note += '---\n'

				if (this.settings.downloadAudio) {
					const audioPath = normalizePath(`${voiceNotesDir}/audio`)

					if (!await this.app.vault.adapter.exists(audioPath)) {
						await this.app.vault.createFolder(audioPath)
					}
					const outputLocationPath = normalizePath(`${audioPath}/${recording.recording_id}.mp3`);

					if (!await this.app.vault.adapter.exists(outputLocationPath)) {
						// Get unique audio download URL and download file to disk
						const signedUrl = await this.vnApi.getSignedUrl(recording.recording_id)
						await this.vnApi.downloadFile(this.fs, signedUrl.url, outputLocationPath);
					}

					note += `![[${recording.recording_id}.mp3]]\n\n`
					note += '# Transcript\n'
				}
				note += recording.transcript
				note += '\n'
				for (const creation of recording.creations) {
					note += `## ${capitalizeFirstLetter(creation.type)}\n`

					if (creation.type === 'email') {
						const creationData = creation.content.data as VoiceNoteEmail
						note += `**Subject:** ${creationData.subject}\n\n`
						note += `${creationData.body}\n`
					} else if (creation.type === 'todo') {
						const creationData = creation.content.data as string[]

						if (Array.isArray(creationData)) {
							note += creationData.map(data => `- [ ] ${data}${this.settings.todoTag ? ' #' + this.settings.todoTag : ''}`).join('\n')
						}
					} else if (creation.type !== 'tweet' && creation.type !== 'summary') {
						const creationData = creation.content.data as string[]

						if (Array.isArray(creationData)) {
							note += creationData.map(data => `- ${data}`).join('\n')
						}

						note += '\n'
					} else {
						const creationData = creation.content.data as string
						note += creationData
						note += '\n'
					}
				}

				if (recording.related_notes.length > 0) {
					note += '\n## Related Notes\n'
					note += recording.related_notes.map(relatedNote => `- [[${this.sanitizedTitle(relatedNote.title, relatedNote.created_at)}]]`).join('\n')
				}
				console.debug(`Writing ${recording.recording_id} to ${recordingPath}`)

				if (await this.app.vault.adapter.exists(recordingPath)) {
					await this.app.vault.modify(this.app.vault.getFileByPath(recordingPath), note)
				} else {
					await this.app.vault.create(recordingPath, note)
				}

				this.syncedRecordingIds.push(recording.recording_id)

				// DESTRUCTIVE action which will delete all synced recordings from server if turned on
				// We ask twice to make sure user is doubly sure
				if (this.settings.deleteSynced && this.settings.reallyDeleteSynced) {
					await this.vnApi.deleteRecording(recording.recording_id)
				}
			}
		}

		window.clearInterval(this.syncInterval)
		this.syncInterval = window.setInterval(() => {
			this.timeSinceSync += this.ONE_SECOND

			if (this.timeSinceSync >= this.settings.syncTimeout * 60 * 1000) {
				this.timeSinceSync = 0
				this.sync()
			}
		}, this.ONE_SECOND)

	}
}

class VoiceNotesSettingTab extends PluginSettingTab {
	plugin: VoiceNotesPlugin;
	vnApi: VoiceNotesApi;
	password: string;

	constructor(app: App, plugin: VoiceNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.vnApi = new VoiceNotesApi({});
	}

	async display(): Promise<void> {
		let { containerEl } = this;

		containerEl.empty();

		if (!this.plugin.settings.token) {
			new Setting(containerEl)
				.setName('Username')
				.addText(text => text
					.setPlaceholder('Email address')
					.setValue(this.plugin.settings.username)
					.onChange(async (value) => {
						this.plugin.settings.username = value;
						await this.plugin.saveSettings();
					}));
			new Setting(containerEl)
				.setName('Password')
				.addText(text => text
					.setPlaceholder('Password')
					.setValue(this.plugin.settings.password)
					.onChange(async (value) => {
						this.password = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.addButton(button => button
					.setButtonText("Login")
					.onClick(async (evt) => {
						this.plugin.settings.token = await this.vnApi.login({
							username: this.plugin.settings.username,
							password: this.password
						})

						this.plugin.settings.password = null
						if (this.plugin.settings.token) {
							new Notice("Login to voicenotes.com was successful")
							await this.plugin.saveSettings()
							await this.display()
						} else {
							new Notice("Login to voicenotes.com was unsuccessful")
						}
					})
				)

			new Setting(containerEl)
				.setName('Auth Token')
				.addText(text => text
					.setPlaceholder('12345|abcdefghijklmnopqrstuvwxyz')
					.setValue(this.plugin.settings.token)
					.onChange(async (value) => {
						this.plugin.settings.token = value;
						await this.plugin.saveSettings();
					}));
			new Setting(containerEl)
				.addButton(button => button
					.setButtonText("Login with token")
					.onClick(async (evt) => {
						this.vnApi.setToken(this.plugin.settings.token)
						const response = await this.vnApi.getUserInfo()
						this.plugin.settings.password = null

						if (response) {
							new Notice("Login to voicenotes.com was successful")
							await this.plugin.saveSettings()
							await this.display()
						} else {
							new Notice("Login to voicenotes.com was unsuccessful")
						}
					})
				)
		}
		if (this.plugin.settings.token) {
			this.vnApi.setToken(this.plugin.settings.token)

			const userInfo = await this.vnApi.getUserInfo()

			new Setting(containerEl)
				.setName("Name")
				.addText(text => text
					.setPlaceholder(userInfo.name)
					.setDisabled(true)
				)
			new Setting(containerEl)
				.setName("Email")
				.addText(text => text
					.setPlaceholder(userInfo.email)
					.setDisabled(true)
				)
			new Setting(containerEl)
				.addButton(button => button
					.setButtonText("Logout")
					.onClick(async (evt) => {
						new Notice("Logged out of voicenotes.com")
						this.plugin.settings.token = null
						this.plugin.settings.password = null
						this.password = null
						await this.plugin.saveSettings()
						await this.display()
					})
				)

			new Setting(containerEl)
				.setName("Force Sync")
				.setDesc("Manual synchronization -- only use the overwrite manual sync if you're ok with overwriting already synced notes")
				.addButton(button => button
					.setButtonText("Manual sync")
					.onClick(async (evt) => {
						new Notice("Performing manual synchronization without overwriting existing work.")
						await this.plugin.sync();
						new Notice("Manual synchronization has completed.")
					})
				)
				.addButton(button => button
					.setButtonText("Manual sync (overwrite)")
					.onClick(async (evt) => {
						// Upon a manual sync we are going to forget about existing data so we can sync all again
						new Notice("Performing manual synchronization and overwriting all notes.")
						this.plugin.syncedRecordingIds = [];
						await this.plugin.sync(true);
						new Notice("Manual synchronization with overwrite has completed.")
					})
				)

		}

		new Setting(containerEl)
			.setName("Sync every")
			.setDesc("Number of minutes between syncing with VoiceNotes.com servers")
			.addText(text => text
				.setPlaceholder("30")
				.setValue(`${this.plugin.settings.syncTimeout}`)
				.onChange(async (value) => {
					this.plugin.settings.syncTimeout = Number(value);
					await this.plugin.saveSettings();
				})
			)

		new Setting(containerEl)
			.setName("Sync directory")
			.setDesc("Directory to sync voice notes")
			.addText(text => text
				.setPlaceholder("voicenotes")
				.setValue(`${this.plugin.settings.syncDirectory}`)
				.onChange(async (value) => {
					this.plugin.settings.syncDirectory = value;
					await this.plugin.saveSettings();
				})
			)

		new Setting(containerEl)
			.setName("Add a tag to todos")
			.setDesc("When syncing a note add an optional tag to the todo")
			.addText(text => text
				.setPlaceholder("TODO")
				.setValue(this.plugin.settings.todoTag)
				.onChange(async (value) => {
					this.plugin.settings.todoTag = value;
					await this.plugin.saveSettings();
				})
			)

		new Setting(containerEl)
			.setName("Download audio")
			.setDesc("Store and download the audio associated with the transcript")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.downloadAudio)
				.onChange(async (value) => {
					this.plugin.settings.downloadAudio = Boolean(value);
					await this.plugin.saveSettings();
				})
			)


		new Setting(containerEl)
			.setName("Prepend Date to Note Title")
			.setDesc("Adding the dates to the file names of all synced notes")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.prependDateToTitle)
				.onChange(async (value) => {
					this.plugin.settings.prependDateToTitle = value;
					await this.plugin.saveSettings();
				})
			)

		new Setting(containerEl)
			.setName("Delete synced recordings")
			.setDesc("DESTRUCTIVE action which after syncing the note locally will delete it from the voicenotes.com server.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.deleteSynced)
				.onChange(async (value) => {
					this.plugin.settings.deleteSynced = value;

					if (!value) {
						this.plugin.settings.reallyDeleteSynced = false;
					}

					await this.plugin.saveSettings();
					await this.display()
				})
			)

		if (this.plugin.settings.deleteSynced) {
			new Setting(containerEl)
				.setName("REALLY delete synced recordings")
				.setDesc("We want you to be sufficiently clear that this will delete anything on voicenotes.com")
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.reallyDeleteSynced)
					.onChange(async (value) => {
						this.plugin.settings.reallyDeleteSynced = Boolean(value);
						await this.plugin.saveSettings();
					})
				)
		}
	}
}
