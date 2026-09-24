export type NoteKind = 'task' | 'context' | 'note'
export type TaskState = 'open' | 'working' | 'blocked' | 'done'
export type CaptureState = 'pending' | 'captured' | 'none' | 'legacy_unknown'
export type LinkKind = 'relates_to' | 'depends_on' | 'learned_from'

export interface BoardLink { to: string; kind: LinkKind }
export interface Evidence { path: string; detail?: string }
export interface BoardImage { id: string; path: string; name: string; mime: string; size: number; description?: string; preview?: string }
export interface UserSource { title: string; body: string }
export interface BoardNote {
  id: string
  kind: NoteKind
  title: string
  body: string
  createdAt: string
  updatedAt: string
  updatedBy: string
  revision: string
  sectionId: string
  links: BoardLink[]
  images?: BoardImage[]
  userSource?: UserSource
  status?: TaskState
  acceptance?: string[]
  sessionId?: string
  agent?: string
  outcome?: string
  captureState?: CaptureState
  noLearningReason?: string
  subject?: string
  evidence?: Evidence[]
  sourceTaskIds?: string[]
  verifiedAt?: string
  legacyStatus?: string
}
export interface BoardSection { id: string; title: string; x: number; y: number; width: number; height: number; collapsed: boolean }
export interface BoardPosition { x: number; y: number }
export interface BoardSnapshot {
  repo: string
  notes: BoardNote[]
  sections: BoardSection[]
  positions: Record<string, BoardPosition>
  errors: string[]
  readOnly: boolean
}
export type BoardCommand =
  | { type: 'createNote'; note: Partial<BoardNote> & Pick<BoardNote, 'kind' | 'title'>; position?: BoardPosition; operationId?: string }
  | { type: 'updateNote'; id: string; patch: Partial<BoardNote>; expectedRevision: string; operationId?: string }
  | { type: 'moveNote'; id: string; position: BoardPosition; sectionId?: string; expectedRevision?: string; operationId?: string }
  | { type: 'createSection'; title: string; position: BoardPosition; operationId?: string }
  | { type: 'updateSection'; id: string; patch: Partial<BoardSection>; operationId?: string }
  | { type: 'deleteSection'; id: string; keepNotes: boolean; operationId?: string }
  | { type: 'trashNote'; id: string; expectedRevision: string; operationId?: string }
  | { type: 'restoreNote'; id: string; operationId?: string }
  | { type: 'completeTask'; id: string; expectedRevision: string; outcome: string; acceptance: string[]; contextChanges: Array<{ id?: string; expectedRevision?: string; title: string; body: string; subject: string; evidence: Evidence[] }>; noLearningReason?: string; actor: string; operationId: string }
export type BoardQuery =
  | { type: 'summary' }
  | { type: 'search'; text?: string; kind?: NoteKind; status?: TaskState; sectionId?: string; path?: string; linkedTo?: string; limit?: number }
  | { type: 'read'; id: string }
  | { type: 'related'; id: string }
  | { type: 'history'; id: string }
  | { type: 'trash' }
