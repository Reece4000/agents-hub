import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoardAgent } from '../server/board-agent'
import type { BoardNote } from '../shared/board'

test('a second agent finds context captured from a completed task', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-hub-board-agent-'))
  const first = new BoardAgent(repo)
  try {
    const task = first.store.apply(repo, { type: 'createNote', note: { kind: 'task', title: 'Inspect persistence' } }) as BoardNote
    const complete = first.call('board_complete_task', { id: task.id, expectedRevision: task.revision, outcome: 'Verified persistence', acceptance: ['Reload succeeds'], contextChanges: [{ title: 'Board files', subject: 'board persistence', body: 'Board note content is stored separately from canvas positions.', evidence: [{ path: 'server/board-store.ts' }] }], operationId: 'test_completion_1' }) as BoardNote
    assert.equal(complete.captureState, 'captured')
    const second = new BoardAgent(repo)
    try {
      const results = second.call('board_search', { kind: 'context', text: 'positions' }) as BoardNote[]
      assert.equal(results.length, 1)
      assert.deepEqual(results[0].sourceTaskIds, [task.id])
      assert.equal((second.call('board_related', { id: task.id }) as BoardNote[])[0].id, results[0].id)
    } finally { second.close() }
  } finally { first.close(); rmSync(repo, { recursive: true, force: true }) }
})

test('separate agent writers must reload a changed task revision', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-hub-board-conflict-'))
  const first = new BoardAgent(repo), second = new BoardAgent(repo)
  try {
    const task = first.store.apply(repo, { type: 'createNote', note: { kind: 'task', title: 'Shared task' } }) as BoardNote
    first.call('board_update_task', { id: task.id, expectedRevision: task.revision, status: 'working' })
    assert.throws(() => second.call('board_update_task', { id: task.id, expectedRevision: task.revision, status: 'blocked' }), /changed on disk|Reload/)
    assert.equal((second.call('board_read', { id: task.id }) as BoardNote).status, 'working')
  } finally { first.close(); second.close(); rmSync(repo, { recursive: true, force: true }) }
})
