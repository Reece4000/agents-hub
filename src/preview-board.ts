import type { BoardCommand, BoardNote, BoardQuery, BoardSection, BoardSnapshot } from '../shared/board'

const key = 'agent-hub-board-preview-v2'
const stamp = new Date().toISOString()
const id = () => `AH-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`
const revision = () => crypto.randomUUID()
const note = (value: Partial<BoardNote> & Pick<BoardNote, 'kind' | 'title' | 'id'>): BoardNote => ({
  body: '', createdAt: stamp, updatedAt: stamp, updatedBy: 'preview', revision: revision(), sectionId: '', links: [], ...value,
})
const defaultRepo = '/Projects/agent-hub'
const initial: BoardSnapshot = {
  repo: defaultRepo, readOnly: false, errors: [],
  sections: [
    { id: 'SC-1A2B3C4D5E6F', title: 'Product surface', x: 100, y: 140, width: 645, height: 545, collapsed: false },
    { id: 'SC-7A8B9C0D1E2F', title: 'System knowledge', x: 810, y: 140, width: 680, height: 545, collapsed: false },
  ],
  positions: {
    'AH-A17C42D0': { x: 145, y: 225 }, 'AH-5D2B8F31': { x: 430, y: 225 }, 'AH-8F11C603': { x: 145, y: 450 },
    'AH-70C39A4E': { x: 850, y: 225 }, 'AH-274A13BE': { x: 1135, y: 225 }, 'AH-B320D9A5': { x: 850, y: 450 },
  },
  notes: [
    note({ id: 'AH-A17C42D0', kind: 'task', title: 'Make the board agent-aware', body: 'Agents should be able to discover, search and update the entire board from their coding session.', status: 'working', acceptance: ['Query notes by kind and subject', 'A second session can retrieve a prior learning'], agent: 'Codex', sessionId: 'preview-1', captureState: 'pending', sectionId: 'SC-1A2B3C4D5E6F', links: [{ to: 'AH-70C39A4E', kind: 'relates_to' }] }),
    note({ id: 'AH-5D2B8F31', kind: 'note', title: 'What should a session remember?', body: 'A session is a place to work. The board is the memory that survives across sessions. Keep those identities separate.', sectionId: 'SC-1A2B3C4D5E6F' }),
    note({ id: 'AH-8F11C603', kind: 'task', title: 'Polish canvas navigation', body: 'Keep a large map usable: pan, zoom, search, and focus any note.', status: 'blocked', sessionId: 'preview-2',
      question: { text: 'Should the camera animate when search jumps to a note, or cut instantly?', options: ['Animate', 'Cut instantly'], askedBy: 'Claude Code', askedAt: new Date(Date.now() - 4 * 60_000).toISOString(), terminalId: 'preview-2-claude' },
      log: [{ at: new Date(Date.now() - 20 * 60_000).toISOString(), actor: 'Claude Code', text: 'Mapped zoom and pan handlers in BoardCanvas.tsx' }, { at: new Date(Date.now() - 4 * 60_000).toISOString(), actor: 'Claude Code', text: 'Asked: Should the camera animate when search jumps to a note, or cut instantly?' }], acceptance: ['Keyboard can reach every note', 'Search focuses offscreen results'], captureState: 'pending', sectionId: 'SC-1A2B3C4D5E6F' }),
    note({ id: 'AH-70C39A4E', kind: 'context', title: 'Board storage contract', body: 'Notes live in repo-local Markdown files. Geometry is stored separately so moving cards never overwrites their content.', subject: 'board storage', evidence: [{ path: 'server/board-store.ts', detail: 'note and layout writes' }], sourceTaskIds: ['AH-A17C42D0'], verifiedAt: stamp, sectionId: 'SC-7A8B9C0D1E2F' }),
    note({ id: 'AH-274A13BE', kind: 'context', title: 'Terminal ownership', body: 'Each Session groups independently running agent and shell terminals. Provider conversations remain inside their own CLI.', subject: 'terminal ownership', evidence: [{ path: 'server/service.ts', detail: 'terminalOpen' }], sourceTaskIds: [], verifiedAt: stamp, sectionId: 'SC-7A8B9C0D1E2F' }),
    note({ id: 'AH-B320D9A5', kind: 'note', title: 'Open question · evidence', body: 'How should the interface show that a context fact has become stale after code changes?', sectionId: 'SC-7A8B9C0D1E2F' }),
  ],
}

export function previewBoard() {
  let boards: Record<string, BoardSnapshot>
  try { boards = JSON.parse(localStorage.getItem(key) || 'null') || { [defaultRepo]: initial } } catch { boards = { [defaultRepo]: initial } }
  let trashed: Record<string, BoardNote[]>
  try { trashed = JSON.parse(localStorage.getItem(`${key}-trash`) || '{}') } catch { trashed = {} }
  const listeners = new Set<(snapshot: BoardSnapshot) => void>()
  const board = (repo: string) => boards[repo] ?? (boards[repo] = { repo, notes: [], positions: {}, sections: [], errors: [], readOnly: false })
  const emit = (repo: string) => { localStorage.setItem(key, JSON.stringify(boards)); localStorage.setItem(`${key}-trash`, JSON.stringify(trashed)); listeners.forEach(listener => listener(structuredClone(board(repo)))) }
  const find = (repo: string, id: string) => board(repo).notes.find(item => item.id === id)
  const apply = (repo: string, command: BoardCommand): unknown => {
    const data = board(repo)
    let result: unknown = null
    if (command.type === 'createNote') {
      const created = note({ ...command.note, id: command.note.id || id(), title: command.note.title.trim(), updatedAt: new Date().toISOString(), ...(command.note.kind === 'task' ? { status: 'open', acceptance: [], captureState: 'pending' } : {}) })
      data.notes.push(created); data.positions[created.id] = command.position ?? { x: 100, y: 100 }; result = created
    } else if (command.type === 'updateNote') {
      const current = find(repo, command.id)
      if (!current || current.revision !== command.expectedRevision) throw new Error('This note changed. Reload it before saving.')
      if (command.patch.status === 'done' && current.status !== 'done') throw new Error('Complete the task with an outcome and codebase learning.')
      Object.assign(current, command.patch, { revision: revision(), updatedAt: new Date().toISOString() }); result = current
    } else if (command.type === 'moveNote') {
      const current = find(repo, command.id)
      if (!current) throw new Error('Note no longer exists.')
      data.positions[current.id] = command.position
      if (command.sectionId !== undefined) { current.sectionId = command.sectionId; current.revision = revision() }
      result = current
    } else if (command.type === 'createSection') {
      const section: BoardSection = { id: `SC-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`, title: command.title, x: command.position.x, y: command.position.y, width: 620, height: 410, collapsed: false }
      data.sections.push(section); result = section
    } else if (command.type === 'updateSection') {
      const section = data.sections.find(item => item.id === command.id)
      if (!section) throw new Error('Section no longer exists.')
      const dx = Number(command.patch.x ?? section.x) - section.x, dy = Number(command.patch.y ?? section.y) - section.y
      Object.assign(section, command.patch)
      if (dx || dy) for (const item of data.notes.filter(item => item.sectionId === section.id)) { const position = data.positions[item.id]; if (position) data.positions[item.id] = { x: position.x + dx, y: position.y + dy } }
      result = section
    } else if (command.type === 'deleteSection') {
      data.sections = data.sections.filter(item => item.id !== command.id)
      data.notes = data.notes.filter(item => { if (item.sectionId !== command.id) return true; if (command.keepNotes) { item.sectionId = ''; return true } (trashed[repo] ??= []).push(item); delete data.positions[item.id]; return false })
    } else if (command.type === 'trashNote') {
      const current = find(repo, command.id)
      if (current) (trashed[repo] ??= []).push(current)
      data.notes = data.notes.filter(item => item.id !== command.id)
      delete data.positions[command.id]
    } else if (command.type === 'restoreNote') {
      const current = (trashed[repo] ?? []).find(item => item.id === command.id)
      if (!current) throw new Error('Note is no longer in trash.')
      data.notes.push(current); data.positions[current.id] = { x: 120, y: 120 }
      trashed[repo] = trashed[repo].filter(item => item.id !== command.id)
      result = current
    }
    else if (command.type === 'appendLog' || command.type === 'askQuestion' || command.type === 'answerQuestion') {
      const current = find(repo, command.id)
      if (!current) throw new Error('Note no longer exists.')
      const at = new Date().toISOString()
      if (command.type === 'appendLog') current.log = [...(current.log ?? []), { at, actor: command.actor, text: command.text }]
      else if (command.type === 'askQuestion') Object.assign(current, { status: 'blocked', question: { text: command.text, options: command.options, askedBy: command.actor, askedAt: at }, log: [...(current.log ?? []), { at, actor: command.actor, text: `Asked: ${command.text}` }] })
      else { delete current.question; Object.assign(current, { status: current.status === 'blocked' ? 'working' : current.status, log: [...(current.log ?? []), { at, actor: 'person', text: `Answered: ${command.answer}` }] }) }
      Object.assign(current, { revision: revision(), updatedAt: at }); result = current
    }
    else if (command.type === 'completeTask') {
      const task = find(repo, command.id)
      if (!task || task.revision !== command.expectedRevision) throw new Error('Task changed. Reload before completing.')
      for (const change of command.contextChanges) {
        let target = change.id ? find(repo, change.id) : data.notes.find(item => item.kind === 'context' && item.subject === change.subject)
        if (!target) { target = note({ id: id(), kind: 'context', title: change.title }); data.notes.push(target); data.positions[target.id] = { x: 300, y: 250 } }
        Object.assign(target, { title: change.title, body: change.body, subject: change.subject, evidence: change.evidence, sourceTaskIds: [...new Set([...(target.sourceTaskIds ?? []), task.id])], verifiedAt: stamp, revision: revision() })
        task.links.push({ to: target.id, kind: 'relates_to' })
      }
      Object.assign(task, { status: 'done', outcome: command.outcome, acceptance: command.acceptance, captureState: command.contextChanges.length ? 'captured' : 'none', noLearningReason: command.noLearningReason, revision: revision() })
      result = task
    }
    emit(repo)
    return structuredClone(result)
  }
  const query = (repo: string, request: BoardQuery): unknown => {
    const data = board(repo), notes = data.notes
    if (request.type === 'read') return find(repo, request.id) ?? null
    if (request.type === 'summary') return { total: notes.length, byKind: Object.fromEntries(['task', 'context', 'note'].map(kind => [kind, notes.filter(item => item.kind === kind).length])), sections: data.sections }
    if (request.type === 'related') return notes.filter(item => item.links.some(link => link.to === request.id) || find(repo, request.id)?.links.some(link => link.to === item.id))
    if (request.type === 'history') return []
    if (request.type === 'trash') return structuredClone(trashed[repo] ?? [])
    return notes.filter(item => (!request.kind || item.kind === request.kind) && (!request.status || item.status === request.status) && (!request.sectionId || item.sectionId === request.sectionId) && (!request.text || `${item.title} ${item.body}`.toLowerCase().includes(request.text.toLowerCase()))).slice(0, request.limit ?? 50)
  }
  return { load: (repo: string) => structuredClone(board(repo)), apply, query, subscribe: (listener: (snapshot: BoardSnapshot) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
}
