
/*
{
    data: {[
      created_at: ISO,
      creations: [{
        content: {
          data: ["","",""]
        },
        created_at: ISO,
        id: 9231,
        recording_ids: [int,],
        type: "points|todo|summary|tweet|email|blog",
        updated_at: ISO
      }],
      duration: 86000,
      id: 24786,
      public_slug: null,
      recording_id: 24786,
      tags: [],
      title: "Inject....",
      transcript: "While the importance of being earnest...",
      updated_at: ISO
    ]},
    links: {
      first: URL or null,
      next: URL or null,
      prev: URL or null
    },
    meta: {
      current_page: 1,
      from: 1,
      path: URL,
      per_page: 10,
      to: 3
    }
}
 */

export interface VoiceNoteData {
    data: string[] | VoiceNoteEmail | string,
}

export interface VoiceNoteEmail {
    subject: string,
    body: string,
}

export interface VoiceNoteCreation {
    created_at: string,
    updated_at: string,
    type: string,
    id: number,
    recording_ids: number[],
    content: VoiceNoteData,
}
export interface VoiceNoteRecordings {
    data: VoiceNoteEntry[],
    links: VoiceNotesLinks,
    meta: VoiceNotesMeta,
}

export interface VoiceNoteEntry {
    created_at: string,
    creations: VoiceNoteCreation[],
    duration: number,
    id: number,
    public_slug?: string,
    recording_id: number,
    tags: [],
    title: string,
    transcript: string,
    updated_at: string
}

export interface VoiceNotesLinks {
    first?: string,
    next?: string,
    prev?: string
}

export interface VoiceNotesMeta {
    current_page: number,
    from: number,
    path?: string,
    per_page: number,
    to: number,
}