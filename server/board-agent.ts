import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BoardStore } from './board-store'
import type { BoardCommand, BoardNote, Evidence, NoteKind, TaskState } from '../shared/board'

type Args = Record<string, unknown>
const string = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const required = (value: unknown, label: string) => { const result = string(value); if (!result) throw new Error(`${label} is required.`); return result }
const limit = (value: unknown) => Math.max(1, Math.min(100, Number(value) || 30))

/** The CLI and MCP transport share the desktop board store and its revision rules. */
export class BoardAgent {
  readonly repo: string
  readonly store: BoardStore
  constructor(repo: string, store = new BoardStore()) {
    this.repo = realpathSync(resolve(repo))
    this.store = store
  }
  close() { this.store.close() }
  call(name: string, args: Args = {}): unknown {
    switch (name) {
      case 'board_summary': return this.store.query(this.repo, { type: 'summary' })
      case 'board_search': return this.store.query(this.repo, { type: 'search', text: string(args.text), kind: args.kind as NoteKind | undefined, status: args.status as TaskState | undefined, sectionId: string(args.sectionId), path: string(args.path), linkedTo: string(args.linkedTo), limit: limit(args.limit) })
      case 'board_read': return this.store.query(this.repo, { type: 'read', id: required(args.id, 'id') })
      case 'board_related': return this.store.query(this.repo, { type: 'related', id: required(args.id, 'id') })
      case 'board_update_task': {
        const id = required(args.id, 'id')
        const current = this.store.query(this.repo, { type: 'read', id }) as BoardNote | null
        if (!current || current.kind !== 'task') throw new Error('Task not found.')
        const expectedRevision = required(args.expectedRevision, 'expectedRevision')
        const patch: Partial<BoardNote> = { updatedBy: string(args.actor) || 'agent' }
        if ('status' in args) patch.status = args.status as TaskState
        if ('body' in args) patch.body = string(args.body)
        if ('outcome' in args) patch.outcome = string(args.outcome)
        if ('sessionId' in args) patch.sessionId = string(args.sessionId)
        return this.store.apply(this.repo, { type: 'updateNote', id, expectedRevision, patch })
      }
      case 'board_upsert_context': {
        const id = string(args.id)
        const title = required(args.title, 'title'), subject = required(args.subject, 'subject'), body = required(args.body, 'body')
        const evidence = Array.isArray(args.evidence) ? args.evidence as Evidence[] : []
        if (!evidence.length) throw new Error('Add at least one evidence path.')
        if (id) {
          const current = this.store.query(this.repo, { type: 'read', id }) as BoardNote | null
          if (!current || current.kind !== 'context') throw new Error('Context note not found.')
          return this.store.apply(this.repo, { type: 'updateNote', id, expectedRevision: required(args.expectedRevision, 'expectedRevision'), patch: { title, subject, body, evidence, updatedBy: string(args.actor) || 'agent' } })
        }
        return this.store.apply(this.repo, { type: 'createNote', note: { kind: 'context', title, subject, body, evidence, updatedBy: string(args.actor) || 'agent' } })
      }
      case 'board_complete_task': {
        const command: Extract<BoardCommand, { type: 'completeTask' }> = {
          type: 'completeTask', id: required(args.id, 'id'), expectedRevision: required(args.expectedRevision, 'expectedRevision'),
          outcome: required(args.outcome, 'outcome'), acceptance: Array.isArray(args.acceptance) ? args.acceptance as string[] : [],
          contextChanges: Array.isArray(args.contextChanges) ? args.contextChanges as Extract<BoardCommand, { type: 'completeTask' }>['contextChanges'] : [],
          noLearningReason: string(args.noLearningReason), actor: string(args.actor) || 'agent', operationId: string(args.operationId) || randomUUID(),
        }
        return this.store.apply(this.repo, command)
      }
      default: throw new Error(`Unknown board action: ${name}`)
    }
  }
}

export const boardTools = [
  { name: 'board_summary', description: 'Get a bounded overview of all Tasks, Notes, Context and sections in this repository.', inputSchema: { type: 'object', properties: {} } },
  { name: 'board_search', description: 'Find any board note, including offscreen and completed notes. Filter by text, kind, status, sectionId, path, or linkedTo.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, kind: { type: 'string', enum: ['task', 'context', 'note'] }, status: { type: 'string', enum: ['open', 'working', 'blocked', 'done'] }, sectionId: { type: 'string' }, path: { type: 'string' }, linkedTo: { type: 'string' }, limit: { type: 'integer' } } } },
  { name: 'board_read', description: 'Read the current content and revision of a note by ID.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'board_related', description: 'Read notes linked to or from a note.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'board_update_task', description: 'Update task progress with optimistic revision checking. Read it again after a conflict.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, expectedRevision: { type: 'string' }, status: { type: 'string', enum: ['open', 'working', 'blocked', 'done'] }, body: { type: 'string' }, outcome: { type: 'string' }, sessionId: { type: 'string' }, actor: { type: 'string' } }, required: ['id', 'expectedRevision'] } },
  { name: 'board_upsert_context', description: 'Create or revise a concise codebase fact with evidence paths. For updates provide ID and expectedRevision.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, expectedRevision: { type: 'string' }, title: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, evidence: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, detail: { type: 'string' } }, required: ['path'] } }, actor: { type: 'string' } }, required: ['title', 'subject', 'body', 'evidence'] } },
  { name: 'board_complete_task', description: 'Finish a task and atomically journal its durable learning. Provide a contextChanges entry with a concise codebase fact and evidence, or noLearningReason.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, expectedRevision: { type: 'string' }, outcome: { type: 'string' }, acceptance: { type: 'array', items: { type: 'string' } }, contextChanges: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, expectedRevision: { type: 'string' }, title: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, evidence: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }, required: ['title', 'subject', 'body', 'evidence'] } }, noLearningReason: { type: 'string' }, operationId: { type: 'string' }, actor: { type: 'string' } }, required: ['id', 'expectedRevision', 'outcome'] } },
]
