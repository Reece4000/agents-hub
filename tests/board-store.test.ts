import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoardStore } from '../server/board-store'
import type { BoardNote } from '../shared/board'

const repo = () => mkdtempSync(join(tmpdir(), 'agent-hub-board-'))
const command = <T>(value: unknown) => value as T

test('migrates tickets additively and keeps stable IDs and legacy status', () => {
  const root = repo(), store = new BoardStore()
  try {
    const tickets = join(root, '.agents-hub', 'tickets')
    mkdirSync(tickets, { recursive: true })
    const ticket = { id: 'AH-1234ABCD', title: 'Map the schema', status: 'completed', priority: 'high', description: 'Read the migration code.', acceptance: ['Find the owner'], agent: 'Codex', contextId: 'ctx-one', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-02T00:00:00.000Z' }
    const original = JSON.stringify(ticket)
    writeFileSync(join(tickets, `${ticket.id}.json`), original)
    const first = store.load(root)
    assert.equal(first.notes.length, 1)
    assert.equal(first.notes[0].id, ticket.id)
    assert.equal(first.notes[0].status, 'done')
    assert.equal(first.notes[0].captureState, 'legacy_unknown')
    assert.equal(first.notes[0].sessionId, 'ctx-one')
    assert.deepEqual(first.notes[0].acceptance, ['Find the owner'])
    assert.equal(readFileSync(join(tickets, `${ticket.id}.json`), 'utf8'), original)
    assert.equal(store.load(root).notes.length, 1)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('notes, layout, search and revision conflicts share one store', () => {
  const root = repo(), store = new BoardStore()
  try {
    const section = command<{ id: string }>(store.apply(root, { type: 'createSection', title: 'Database', position: { x: 400, y: 200 } }))
    const note = command<BoardNote>(store.apply(root, { type: 'createNote', note: { kind: 'context', title: 'Orders table', body: 'Orders reference customers.' }, position: { x: 470, y: 270 } }))
    const moved = command<BoardNote>(store.apply(root, { type: 'moveNote', id: note.id, position: { x: 500, y: 300 }, sectionId: section.id, expectedRevision: note.revision }))
    assert.equal(moved.sectionId, section.id)
    assert.deepEqual(store.load(root).positions[note.id], { x: 500, y: 300 })
    assert.equal((store.query(root, { type: 'search', text: 'customers', kind: 'context' }) as BoardNote[])[0].id, note.id)
    const updated = command<BoardNote>(store.apply(root, { type: 'updateNote', id: note.id, expectedRevision: moved.revision, patch: { body: 'Orders reference accounts.' } }))
    assert.throws(() => store.apply(root, { type: 'updateNote', id: note.id, expectedRevision: moved.revision, patch: { body: 'stale' } }), /changed on disk/)
    assert.equal((store.query(root, { type: 'history', id: note.id }) as Array<{ note: BoardNote }>).at(-1)?.note.body, 'Orders reference customers.')
    store.apply(root, { type: 'trashNote', id: note.id, expectedRevision: updated.revision })
    assert.equal(store.load(root).notes.length, 0)
    store.apply(root, { type: 'restoreNote', id: note.id })
    assert.equal(store.load(root).notes.length, 1)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('context notes without saved positions get distinct draggable canvas positions', () => {
  const root = repo(), store = new BoardStore()
  try {
    const task = command<BoardNote>(store.apply(root, { type: 'createNote', note: { kind: 'task', title: 'Implement canvas drag' }, position: { x: 50, y: 80 } }))
    const contexts = ['Drag behavior', 'Canvas geometry', 'Pointer events'].map(title =>
      command<BoardNote>(store.apply(root, { type: 'createNote', note: { kind: 'context', title, links: [{ to: task.id, kind: 'learned_from' }], sourceTaskIds: [task.id] } }))
    )
    const canvas = join(root, '.agents-hub', 'canvas.json')
    const layout = JSON.parse(readFileSync(canvas, 'utf8'))
    for (const note of contexts) delete layout.positions[note.id]
    writeFileSync(canvas, `${JSON.stringify(layout, null, 2)}\n`)

    const loaded = store.load(root)
    const positions = contexts.map(note => loaded.positions[note.id])
    assert.ok(positions.every(Boolean))
    for (let left = 0; left < positions.length; left++) for (let right = left + 1; right < positions.length; right++) {
      assert.ok(Math.abs(positions[left].x - positions[right].x) >= 246 || Math.abs(positions[left].y - positions[right].y) >= 172)
    }
    assert.ok(positions.every(position => Math.abs(position.x - 50) >= 246 || Math.abs(position.y - 80) >= 172))
    assert.deepEqual(loaded.positions[task.id], { x: 50, y: 80 })
    assert.deepEqual(JSON.parse(readFileSync(canvas, 'utf8')).positions[contexts[0].id], positions[0])

    const moved = { x: positions[0].x + 90, y: positions[0].y + 40 }
    store.apply(root, { type: 'moveNote', id: contexts[0].id, position: moved, expectedRevision: contexts[0].revision })
    assert.deepEqual(store.load(root).positions[contexts[0].id], moved)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('image assets persist with notes and reject mismatched content', () => {
  const root = repo(), store = new BoardStore()
  try {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
    const image = store.saveImage(root, 'example.png', 'image/png', bytes.toString('base64'))
    const note = command<BoardNote>(store.apply(root, { type: 'createNote', note: { kind: 'note', title: 'Screenshot', images: [image] } }))
    assert.equal(store.load(root).notes.find(item => item.id === note.id)?.images?.[0].path, image.path)
    assert.equal(store.imagePreview(root, image.id), `data:image/png;base64,${bytes.toString('base64')}`)
    assert.throws(() => store.saveImage(root, 'fake.png', 'image/png', Buffer.from('not an image').toString('base64')), /does not match/)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('completion captures evidence and links a reusable context note', () => {
  const root = repo(), store = new BoardStore()
  try {
    const task = command<BoardNote>(store.apply(root, { type: 'createNote', note: { kind: 'task', title: 'Trace login persistence' } }))
    const operation = { type: 'completeTask' as const, id: task.id, expectedRevision: task.revision, outcome: 'Session tokens are stored in the sessions table.', acceptance: ['Login survives restart'], actor: 'Codex', operationId: 'complete_login_001', contextChanges: [{ title: 'Session storage', subject: 'authentication session persistence', body: 'Login tokens are stored in the sessions table and loaded at startup.', evidence: [{ path: 'server/auth.ts', detail: 'restoreSession' }] }] }
    const completed = command<BoardNote>(store.apply(root, operation))
    assert.equal(completed.status, 'done')
    assert.equal(completed.captureState, 'captured')
    const context = store.load(root).notes.find(note => note.kind === 'context')!
    assert.ok(context)
    assert.deepEqual(context.sourceTaskIds, [task.id])
    assert.equal((store.query(root, { type: 'search', text: 'tokens', kind: 'context' }) as BoardNote[])[0].id, context.id)
    assert.equal((store.query(root, { type: 'related', id: task.id }) as BoardNote[])[0].id, context.id)
    assert.equal(command<BoardNote>(store.apply(root, operation)).id, task.id)
    assert.equal(store.load(root).notes.length, 2)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('one malformed note does not hide valid notes, and direct edits reindex', async () => {
  const root = repo(), store = new BoardStore()
  try {
    const note = command<BoardNote>(store.apply(root, { type: 'createNote', note: { kind: 'note', title: 'A discovery', body: 'old fact' } }))
    const file = join(root, '.agents-hub', 'notes', `${note.id}.md`)
    const raw = readFileSync(file, 'utf8')
    writeFileSync(join(root, '.agents-hub', 'notes', 'AH-FFEEDDCC.md'), 'broken')
    const damaged = store.load(root)
    assert.equal(damaged.notes.length, 1)
    assert.ok(damaged.errors.length)
    const bodyOffset = raw.lastIndexOf('old fact')
    writeFileSync(file, `${raw.slice(0, bodyOffset)}new fact${raw.slice(bodyOffset + 'old fact'.length)}`)
    assert.equal((store.query(root, { type: 'search', text: 'new fact' }) as BoardNote[]).length, 1)
    assert.ok(existsSync(file))
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('history path symlinks cannot redirect revisions outside the repository', () => {
  const root = repo(), outside = repo(), store = new BoardStore()
  try {
    const note = command<BoardNote>(store.apply(root, { type: 'createNote', note: { kind: 'note', title: 'Boundary' } }))
    symlinkSync(outside, join(root, '.agents-hub', 'history', note.id))
    assert.throws(() => store.apply(root, { type: 'updateNote', id: note.id, expectedRevision: note.revision, patch: { body: 'Must stay inside' } }), /history must not be a symlink/)
    assert.equal((store.query(root, { type: 'read', id: note.id }) as BoardNote).body, '')
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})

test('ticket ID collisions surface without overwriting either file', () => {
  const root = repo(), store = new BoardStore()
  try {
    store.load(root)
    const note = command<BoardNote>(store.apply(root, { type: 'createNote', note: { kind: 'note', title: 'Existing', id: 'AH-1234ABCD' } }))
    const original = readFileSync(join(root, '.agents-hub', 'notes', `${note.id}.md`), 'utf8')
    mkdirSync(join(root, '.agents-hub', 'tickets'), { recursive: true })
    writeFileSync(join(root, '.agents-hub', 'tickets', `${note.id}.json`), JSON.stringify({ id: note.id, title: 'Old ticket', status: 'backlog' }))
    const snapshot = store.load(root)
    assert.ok(snapshot.errors.some(error => error.includes('collides')))
    assert.equal(readFileSync(join(root, '.agents-hub', 'notes', `${note.id}.md`), 'utf8'), original)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('agent instructions preserve existing project guidance and avoid symlink targets', () => {
  const root = repo(), outside = repo(), store = new BoardStore()
  try {
    writeFileSync(join(root, 'AGENTS.md'), '# Project rules\n\nKeep tests focused.\n')
    writeFileSync(join(root, 'AGENTS.override.md'), '# Local override\n')
    writeFileSync(join(outside, 'CLAUDE.md'), 'Do not edit me.\n')
    symlinkSync(join(outside, 'CLAUDE.md'), join(root, 'CLAUDE.md'))
    const first = store.load(root)
    assert.ok(first.errors.some(error => error.includes('CLAUDE.md') && error.includes('symlink')))
    assert.equal(readFileSync(join(outside, 'CLAUDE.md'), 'utf8'), 'Do not edit me.\n')
    for (const name of ['AGENTS.md', 'AGENTS.override.md', 'GEMINI.md']) {
      const instructions = readFileSync(join(root, name), 'utf8')
      assert.match(instructions, /Read `.agents-hub\/README.md` before working/)
      assert.equal(instructions.match(/agent-hub:begin/g)?.length, 1)
    }
    const original = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    store.load(root)
    assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), original)
    assert.match(original, /Keep tests focused/)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})
