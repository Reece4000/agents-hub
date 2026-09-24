import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoardStore } from '../server/board-store'
import { BoardAgent } from '../server/board-agent'
import { HubService } from '../server/service'
import type { BoardNote } from '../shared/board'

const withBoard = (run: (repo: string, store: BoardStore) => void | Promise<void>) => async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-hub-tools-'))
  const store = new BoardStore()
  try { store.load(repo); await run(repo, store) } finally { store.close(); rmSync(repo, { recursive: true, force: true }) }
}
const task = (store: BoardStore, repo: string, patch: Partial<BoardNote> = {}) =>
  store.apply(repo, { type: 'createNote', note: { kind: 'task', title: 'Ship hooks', status: 'working', sessionId: 'ctx-1', ...patch } }) as BoardNote

test('agents log progress, ask, and create linked subtasks on their active Task without revisions', withBoard((repo, store) => {
  const parent = task(store, repo)
  const agent = new BoardAgent(repo, undefined, { sessionId: 'ctx-1', terminalId: 'res-9', actor: 'Claude Code' })
  try {
    agent.call('board_log_progress', { text: 'Found the cause in terminals.ts' })
    const child = agent.call('board_create_note', { kind: 'task', title: 'Cover OSC 9 parsing', parentId: parent.id, acceptance: ['Unit test for OSC 9'] }) as BoardNote
    assert.equal(child.parentId, parent.id)
    assert.deepEqual(child.links, [{ to: parent.id, kind: 'relates_to' }])
    assert.equal(child.updatedBy, 'Claude Code')
    agent.call('board_link_notes', { from: parent.id, to: child.id, kind: 'depends_on' })
    const asked = agent.call('board_ask', { question: 'Keep the legacy flag?', options: ['Keep', 'Drop'] }) as BoardNote
    assert.equal(asked.status, 'blocked')
    assert.deepEqual(asked.question && { text: asked.question.text, options: asked.question.options, askedBy: asked.question.askedBy, terminalId: asked.question.terminalId }, { text: 'Keep the legacy flag?', options: ['Keep', 'Drop'], askedBy: 'Claude Code', terminalId: 'res-9' })
    const summary = agent.call('board_summary') as { activeTask: { id: string; question?: string } }
    assert.deepEqual(summary.activeTask, { id: parent.id, title: 'Ship hooks', status: 'blocked', question: 'Keep the legacy flag?' }, 'a blocked Task stays active')
    const answered = store.apply(repo, { type: 'answerQuestion', id: parent.id, answer: 'Drop it' }) as BoardNote
    assert.equal(answered.question, undefined)
    assert.equal(answered.status, 'working')
    assert.deepEqual(answered.log?.map(entry => `${entry.actor}: ${entry.text}`), ['Claude Code: Found the cause in terminals.ts', 'Claude Code: Asked: Keep the legacy flag?', 'person: Answered: Drop it'])
    assert.ok(answered.links.some(link => link.to === child.id && link.kind === 'depends_on'))
    const reread = store.query(repo, { type: 'read', id: parent.id }) as BoardNote
    assert.equal(reread.log?.length, 3, 'progress survives a reload from disk')
  } finally { agent.close() }
}))

test('tools that default to the active Task explain what to do without one', withBoard(repo => {
  const agent = new BoardAgent(repo, undefined, { sessionId: 'nobody' })
  try { assert.throws(() => agent.call('board_log_progress', { text: 'x' }), /No active Task for this Session/) } finally { agent.close() }
}))

test('agents attach screenshots as board images', withBoard(repo => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5d1a8f40000000049454e44ae426082', 'hex')
  writeFileSync(join(repo, 'shot.png'), png)
  const agent = new BoardAgent(repo, undefined, {})
  try {
    const note = agent.call('board_create_note', { kind: 'note', title: 'Before/after' }) as BoardNote
    const updated = agent.call('board_attach_image', { id: note.id, path: 'shot.png', description: 'New tab states' }) as BoardNote
    assert.equal(updated.images?.[0].description, 'New tab states')
    assert.match(updated.images?.[0].path ?? '', /^\.agents-hub\/assets\/.+\.png$/)
    assert.throws(() => agent.call('board_attach_image', { id: note.id, path: 'notes.txt' }), /PNG, JPEG/)
  } finally { agent.close() }
}))

test('a stale editor save merges with an agent\'s progress instead of conflicting', withBoard((repo, store) => {
  const note = task(store, repo)
  store.apply(repo, { type: 'appendLog', id: note.id, actor: 'Codex', text: 'Tests pass' })
  const merged = store.apply(repo, { type: 'updateNote', id: note.id, expectedRevision: note.revision, patch: { title: note.title, body: 'Sharper brief', links: note.links, updatedBy: 'person' } }) as BoardNote
  assert.equal(merged.body, 'Sharper brief')
  assert.equal(merged.log?.[0].text, 'Tests pass', 'the agent entry survives the person\'s edit')
  const latest = store.query(repo, { type: 'read', id: note.id }) as BoardNote
  store.apply(repo, { type: 'updateNote', id: note.id, expectedRevision: latest.revision, patch: { body: 'Agent rewrite', updatedBy: 'agent' } })
  assert.throws(() => store.apply(repo, { type: 'updateNote', id: note.id, expectedRevision: latest.revision, patch: { body: 'Person rewrite', updatedBy: 'person' } }), /changed on disk/, 'both sides changing one field still conflicts')
}))

test('answers and briefings wait in an outbox until the agent is idle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-outbox-'))
  const service = new HubService(dir, dir)
  const writes: string[] = []
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'ops', terminalKind: 'custom', profile: { label: 'Env', executable: '/usr/bin/env', args: [] } })
    const id = context.terminals[0].id
    service.terminals.running = () => true
    service.terminals.write = (_id: string, data: string) => { writes.push(data) }
    service.activity.start(id, { hooks: true })
    service.activity.hook(id, { hook_event_name: 'UserPromptSubmit' })
    assert.equal(service.deliver(id, 'Answer: drop it'), 'queued')
    assert.deepEqual(writes, [], 'nothing is typed while the agent works')
    service.activity.hook(id, { hook_event_name: 'Stop' })
    await new Promise(resolve => setTimeout(resolve, 700))
    assert.deepEqual(writes, ['\x1b[200~Answer: drop it\x1b[201~', '\r'])
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})
