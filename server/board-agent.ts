import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BoardStore } from './board-store'
import { contextFreshness } from './freshness'
import type { BoardCommand, BoardNote, Evidence, LinkKind, NoteKind, TaskState } from '../shared/board'

type Args = Record<string, unknown>
const string = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const required = (value: unknown, label: string) => { const result = string(value); if (!result) throw new Error(`${label} is required.`); return result }
const limit = (value: unknown) => Math.max(1, Math.min(100, Number(value) || 30))
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()).map(item => item.trim()) : []
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

/** Who is calling: the Agent Hub Session and terminal the agent runs in, and
 *  a display name used as the author of its board changes. */
export interface AgentIdentity { sessionId?: string; terminalId?: string; actor?: string }

/** The CLI and MCP transport share the desktop board store and its revision
 *  rules. The Session's working Task is resolved on every call, so a Task
 *  handed to an already-running agent is visible immediately, and tools that
 *  act on "the current Task" default to it. */
export class BoardAgent {
  readonly repo: string
  readonly store: BoardStore
  readonly identity: AgentIdentity
  constructor(repo: string, store = new BoardStore({ passive: true }), identity: AgentIdentity = {}) {
    this.repo = realpathSync(resolve(repo))
    this.store = store
    this.identity = identity
  }
  close() { this.store.close() }
  /** The project's folders, from the project.json Agent Hub keeps beside
   *  the board. A board without one (a repository board) is its own folder. */
  folders(): string[] {
    try {
      const project = JSON.parse(readFileSync(join(this.repo, 'project.json'), 'utf8')) as { folders?: Array<{ path?: unknown }> }
      const folders = (project.folders ?? []).map(folder => folder.path).filter((path): path is string => typeof path === 'string' && isAbsolute(path))
      if (folders.length) return folders
    } catch { /* not a project board */ }
    return [this.repo]
  }
  activeTask(): BoardNote | null {
    if (!this.identity.sessionId) return null
    const working = this.store.query(this.repo, { type: 'search', kind: 'task', limit: 100 }) as BoardNote[]
    return working.filter(note => note.sessionId === this.identity.sessionId && (note.status === 'working' || note.status === 'blocked')).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
  }
  private actor(args: Args) { return string(args.actor) || this.identity.actor || 'agent' }
  /** The note a tool acts on: an explicit id, else the Session's active Task. */
  private target(args: Args) {
    const id = string(args.id)
    if (id) return id
    const active = this.activeTask()
    if (!active) throw new Error('No active Task for this Session. Pass the Task id.')
    return active.id
  }
  private apply(command: BoardCommand) { return this.store.apply(this.repo, command) }
  /** Flag context notes whose evidence changed after they were verified, so
   *  agents know which facts to check before relying on them. */
  private withFreshness(notes: BoardNote[]) {
    const freshness = contextFreshness(this.folders(), notes)
    return notes.map(note => freshness[note.id]?.stale ? { ...note, stale: true, staleReasons: freshness[note.id].reasons } : note)
  }
  call(name: string, args: Args = {}): unknown {
    switch (name) {
      case 'board_summary': {
        const active = this.activeTask()
        return { ...(this.store.query(this.repo, { type: 'summary' }) as object), activeTask: active ? { id: active.id, title: active.title, status: active.status, ...(active.question ? { question: active.question.text } : {}) } : null }
      }
      case 'board_search': return this.withFreshness(this.store.query(this.repo, { type: 'search', text: string(args.text), kind: args.kind as NoteKind | undefined, status: args.status as TaskState | undefined, sectionId: string(args.sectionId), path: string(args.path), linkedTo: string(args.linkedTo), limit: limit(args.limit) }) as BoardNote[])
      case 'board_read': { const note = this.store.query(this.repo, { type: 'read', id: required(args.id, 'id') }) as BoardNote | null; return note ? this.withFreshness([note])[0] : null }
      case 'board_related': return this.store.query(this.repo, { type: 'related', id: required(args.id, 'id') })
      case 'board_update_task': {
        const id = required(args.id, 'id')
        const current = this.store.query(this.repo, { type: 'read', id }) as BoardNote | null
        if (!current || current.kind !== 'task') throw new Error('Task not found.')
        const expectedRevision = required(args.expectedRevision, 'expectedRevision')
        const patch: Partial<BoardNote> = { updatedBy: this.actor(args) }
        if ('status' in args) patch.status = args.status as TaskState
        if ('title' in args) patch.title = string(args.title)
        if ('body' in args) patch.body = string(args.body)
        if ('outcome' in args) patch.outcome = string(args.outcome)
        if ('acceptance' in args) patch.acceptance = strings(args.acceptance)
        if ('sessionId' in args) patch.sessionId = string(args.sessionId)
        return this.apply({ type: 'updateNote', id, expectedRevision, patch })
      }
      case 'board_create_note': {
        const kind = args.kind === 'task' ? 'task' : 'note'
        const parentId = string(args.parentId)
        const links = [...(parentId ? [parentId] : []), ...strings(args.linkTo)].filter((to, index, all) => all.indexOf(to) === index)
        for (const to of links) if (!this.store.query(this.repo, { type: 'read', id: to })) throw new Error(`Note ${to} not found.`)
        return this.apply({ type: 'createNote', note: {
          kind, title: required(args.title, 'title'), body: string(args.body), updatedBy: this.actor(args),
          links: links.map(to => ({ to, kind: 'relates_to' as const })),
          ...(kind === 'task' ? { acceptance: strings(args.acceptance), ...(parentId ? { parentId } : {}) } : {}),
        } })
      }
      case 'board_link_notes': {
        const kind: LinkKind = args.kind === 'depends_on' ? 'depends_on' : 'relates_to'
        return this.apply({ type: 'addLink', id: required(args.from, 'from'), to: required(args.to, 'to'), kind, actor: this.actor(args) })
      }
      case 'board_log_progress': return this.apply({ type: 'appendLog', id: this.target(args), actor: this.actor(args), text: required(args.text, 'text') })
      case 'board_ask': return this.apply({ type: 'askQuestion', id: this.target(args), actor: this.actor(args), text: required(args.question, 'question'), options: strings(args.options), terminalId: this.identity.terminalId })
      case 'board_attach_image': {
        const id = this.target(args)
        const raw = required(args.path, 'path')
        const path = isAbsolute(raw) ? raw : resolve(this.folders()[0], raw)
        const mime = IMAGE_TYPES[extname(path).toLowerCase()]
        if (!mime) throw new Error('Attach a PNG, JPEG, WebP, or GIF image.')
        if (statSync(path).size > 20 * 1024 * 1024) throw new Error('Images must be smaller than 20 MB.')
        const image = this.store.saveImage(this.repo, basename(path), mime, readFileSync(path).toString('base64'))
        const description = string(args.description)
        return this.apply({ type: 'attachImage', id, image: description ? { ...image, description } : image, actor: this.actor(args) })
      }
      case 'board_upsert_context': {
        const id = string(args.id)
        const title = required(args.title, 'title'), subject = required(args.subject, 'subject'), body = required(args.body, 'body')
        const evidence = Array.isArray(args.evidence) ? args.evidence as Evidence[] : []
        if (!evidence.length) throw new Error('Add at least one evidence path.')
        if (id) {
          const current = this.store.query(this.repo, { type: 'read', id }) as BoardNote | null
          if (!current || current.kind !== 'context') throw new Error('Context note not found.')
          return this.apply({ type: 'updateNote', id, expectedRevision: required(args.expectedRevision, 'expectedRevision'), patch: { title, subject, body, evidence, verifiedAt: new Date().toISOString(), updatedBy: this.actor(args) } })
        }
        return this.apply({ type: 'createNote', note: { kind: 'context', title, subject, body, evidence, verifiedAt: new Date().toISOString(), updatedBy: this.actor(args) } })
      }
      case 'board_complete_task': {
        const command: Extract<BoardCommand, { type: 'completeTask' }> = {
          type: 'completeTask', id: required(args.id, 'id'), expectedRevision: required(args.expectedRevision, 'expectedRevision'),
          outcome: required(args.outcome, 'outcome'), acceptance: Array.isArray(args.acceptance) ? args.acceptance as string[] : [],
          contextChanges: Array.isArray(args.contextChanges) ? args.contextChanges as Extract<BoardCommand, { type: 'completeTask' }>['contextChanges'] : [],
          noLearningReason: string(args.noLearningReason), actor: this.actor(args), operationId: string(args.operationId) || randomUUID(),
        }
        return this.apply(command)
      }
      default: throw new Error(`Unknown board action: ${name}`)
    }
  }
}

const id = { type: 'string' }
const optionalTask = { type: 'string', description: 'Task id. Defaults to the Task this Session is working on.' }
export const boardTools = [
  { name: 'board_summary', description: 'Get a bounded overview of all Tasks, Notes, Context and sections in this repository, plus the Task this terminal\'s Session is working on (activeTask), if any.', inputSchema: { type: 'object', properties: {} } },
  { name: 'board_search', description: 'Find any board note, including offscreen and completed notes. Filter by text, kind, status, sectionId, path, or linkedTo.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, kind: { type: 'string', enum: ['task', 'context', 'note'] }, status: { type: 'string', enum: ['open', 'working', 'blocked', 'done'] }, sectionId: { type: 'string' }, path: { type: 'string' }, linkedTo: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'board_read', description: 'Read the current content, revision, progress log, and open question of a note by ID. Context notes whose evidence files changed after they were verified carry stale: true and staleReasons; check the code before relying on them, and re-verify with board_upsert_context.', inputSchema: { type: 'object', properties: { id }, required: ['id'] } },
  { name: 'board_related', description: 'Read notes linked to or from a note.', inputSchema: { type: 'object', properties: { id }, required: ['id'] } },
  { name: 'board_log_progress', description: 'Append one short line to a Task\'s progress timeline, shown live on the person\'s canvas. Use it at meaningful steps (found the cause, tests pass, blocked on X), not for every action.', inputSchema: { type: 'object', properties: { id: optionalTask, text: { type: 'string' } }, required: ['text'] } },
  { name: 'board_ask', description: 'Ask the person a question about a Task when you need a decision you cannot make yourself. The Task becomes blocked and the question appears on its card; the answer is typed into this terminal when the person replies, so end your turn after asking.', inputSchema: { type: 'object', properties: { id: optionalTask, question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, description: 'Up to 8 suggested answers.' } }, required: ['question'] } },
  { name: 'board_create_note', description: 'Create a Task or Note on the canvas. Use parentId to split a Task into smaller Tasks; they appear beside their parent. Use kind "note" for questions, hypotheses, and observations worth keeping.', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['task', 'note'] }, title: { type: 'string' }, body: { type: 'string' }, acceptance: { type: 'array', items: { type: 'string' } }, parentId: { type: 'string' }, linkTo: { type: 'array', items: { type: 'string' } } }, required: ['kind', 'title'] } },
  { name: 'board_link_notes', description: 'Link two notes. kind "depends_on" means `from` cannot finish before `to`.', inputSchema: { type: 'object', properties: { from: id, to: id, kind: { type: 'string', enum: ['relates_to', 'depends_on'] } }, required: ['from', 'to'] } },
  { name: 'board_attach_image', description: 'Attach a PNG, JPEG, WebP, or GIF file (for example a screenshot of your change) to a Task or Note.', inputSchema: { type: 'object', properties: { id: optionalTask, path: { type: 'string', description: 'Absolute path, or relative to the project\'s primary folder.' }, description: { type: 'string' } }, required: ['path'] } },
  { name: 'board_update_task', description: 'Update task progress with optimistic revision checking. Read it again after a conflict.', inputSchema: { type: 'object', properties: { id, expectedRevision: { type: 'string' }, status: { type: 'string', enum: ['open', 'working', 'blocked'] }, title: { type: 'string' }, body: { type: 'string' }, outcome: { type: 'string' }, acceptance: { type: 'array', items: { type: 'string' } }, sessionId: { type: 'string' } }, required: ['id', 'expectedRevision'] } },
  { name: 'board_upsert_context', description: 'Create or revise a concise codebase fact with evidence paths. Search for an existing fact on the same subject first and update it instead of creating a near-duplicate. For updates provide ID and expectedRevision.', inputSchema: { type: 'object', properties: { id, expectedRevision: { type: 'string' }, title: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, evidence: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, detail: { type: 'string' } }, required: ['path'] } } }, required: ['title', 'subject', 'body', 'evidence'] } },
  { name: 'board_complete_task', description: 'Finish a task and atomically journal its durable learning. Provide a contextChanges entry with a concise codebase fact and evidence, or noLearningReason.', inputSchema: { type: 'object', properties: { id, expectedRevision: { type: 'string' }, outcome: { type: 'string' }, acceptance: { type: 'array', items: { type: 'string' } }, contextChanges: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, expectedRevision: { type: 'string' }, title: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, evidence: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, detail: { type: 'string' } }, required: ['path'] } } }, required: ['title', 'subject', 'body', 'evidence'] } }, noLearningReason: { type: 'string' }, operationId: { type: 'string' } }, required: ['id', 'expectedRevision', 'outcome'] } },
]
