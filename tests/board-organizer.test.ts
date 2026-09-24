import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoardStore } from '../server/board-store'
import { BoardOrganizer } from '../server/board-organizer'
import type { BoardNote } from '../shared/board'

test('organizer chooses a provider-specific model for new and legacy configurations', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-hub-organizer-'))
  const store = new BoardStore()
  try {
    const organizer = new BoardOrganizer(store)
    assert.deepEqual(organizer.config(repo), { provider: 'codex', model: 'gpt-6-luna', enabled: false })
    assert.deepEqual(organizer.saveConfig(repo, { provider: 'claude', model: '', enabled: true }), { provider: 'claude', model: 'haiku', enabled: true })
    assert.deepEqual(organizer.config(repo), { provider: 'claude', model: 'haiku', enabled: true })
  } finally { store.close(); rmSync(repo, { recursive: true, force: true }) }
})

test('organizer preserves user text, connects and moves existing cards, then restores the operation', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-hub-organizer-'))
  const store = new BoardStore()
  try {
    const first = store.apply(repo, { type: 'createNote', note: { kind: 'note', title: 'Login idea', body: 'Maybe cache the token.\nCheck expiry first.' }, position: { x: 11, y: 22 } }) as BoardNote
    const second = store.apply(repo, { type: 'createNote', note: { kind: 'note', title: 'Expiry detail', body: 'Expiry is checked at startup.' }, position: { x: 33, y: 44 } }) as BoardNote
    const original = store.load(repo)
    const organizer = new BoardOrganizer(store, async () => JSON.stringify({ notes: [{ id: first.id, title: 'Login idea', body: 'Maybe cache the token.\nCheck expiry first.\n\nRelated expiry context follows.', links: [second.id], group: 'Authentication' }, { id: second.id, group: 'Authentication' }], order: [first.id, second.id] }))
    organizer.saveConfig(repo, { provider: 'codex', model: 'small', enabled: true })
    const result = await organizer.run(repo) as { changedNotes: number; movedNotes: number }
    assert.equal(result.changedNotes, 1)
    assert.equal(result.movedNotes, 2)
    const changed = store.load(repo)
    const note = changed.notes.find(item => item.id === first.id)!
    assert.deepEqual(note.userSource, { title: 'Login idea', body: 'Maybe cache the token.\nCheck expiry first.' })
    assert.match(note.body, /Related expiry context/)
    assert.equal(note.links[0].to, second.id)
    assert.ok(changed.sections.some(section => section.title === 'Authentication'))
    assert.equal(organizer.lastChange(repo)?.changes.length, 1)
    const repeat = await organizer.run(repo) as { changedNotes: number; movedNotes: number }
    assert.equal(repeat.changedNotes, 0)
    assert.equal(repeat.movedNotes, 0)
    organizer.undo(repo)
    const restored = store.load(repo)
    assert.equal(restored.notes.find(item => item.id === first.id)?.body, first.body)
    assert.deepEqual(restored.positions, original.positions)
    assert.deepEqual(restored.sections, original.sections)
  } finally { store.close(); rmSync(repo, { recursive: true, force: true }) }
})

test('organizer rejects stale analysis and never removes a user line', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-hub-organizer-'))
  const store = new BoardStore()
  try {
    const note = store.apply(repo, { type: 'createNote', note: { kind: 'note', title: 'Preserve', body: 'Line one\nLine two' } }) as BoardNote
    const organizer = new BoardOrganizer(store, async () => JSON.stringify({ notes: [{ id: note.id, body: 'Line one', group: 'Notes' }], order: [note.id] }))
    organizer.saveConfig(repo, { provider: 'codex', model: 'small', enabled: false })
    await organizer.run(repo)
    assert.equal((store.query(repo, { type: 'read', id: note.id }) as BoardNote).body, 'Line one\nLine two')
    const stale = new BoardOrganizer(store, async () => {
      const latest = store.query(repo, { type: 'read', id: note.id }) as BoardNote
      store.apply(repo, { type: 'updateNote', id: note.id, expectedRevision: latest.revision, patch: { body: 'A newer correction' } })
      return JSON.stringify({ notes: [{ id: note.id, body: 'Line one\nLine two' }], order: [note.id] })
    })
    await assert.rejects(stale.run(repo), /changed while the organizer was running/)
    assert.equal((store.query(repo, { type: 'read', id: note.id }) as BoardNote).userSource?.body, 'A newer correction')
  } finally { store.close(); rmSync(repo, { recursive: true, force: true }) }
})

test('direct Markdown corrections become the new user source after generated text', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-hub-organizer-'))
  const store = new BoardStore()
  try {
    const note = store.apply(repo, { type: 'createNote', note: { kind: 'note', title: 'Question', body: 'Maybe the cache expires.' } }) as BoardNote
    const organizer = new BoardOrganizer(store, async () => JSON.stringify({ notes: [{ id: note.id, body: 'Maybe the cache expires.\nGenerated connection.' }], order: [note.id] }))
    organizer.saveConfig(repo, { provider: 'codex', model: 'small', enabled: false })
    await organizer.run(repo)
    const path = join(repo, '.agents-hub', 'notes', `${note.id}.md`)
    const original = readFileSync(path, 'utf8')
    writeFileSync(path, original.replace('Generated connection.\n', 'User correction.\n'))
    const corrected = store.query(repo, { type: 'read', id: note.id }) as BoardNote
    assert.equal(corrected.body, 'Maybe the cache expires.\nUser correction.')
    assert.equal(corrected.userSource?.body, corrected.body)
    assert.equal(corrected.updatedBy, 'external')
    await organizer.run(repo)
    assert.equal((store.query(repo, { type: 'read', id: note.id }) as BoardNote).body, corrected.body)
  } finally { store.close(); rmSync(repo, { recursive: true, force: true }) }
})
