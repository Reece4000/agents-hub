import test from 'node:test'
import assert from 'node:assert/strict'
import { newRecord } from '../server/store'
import { defaultResourceFor, ensureTaskIdentity, migrateSessionsToTasks } from '../server/tasks'

test('migration keeps the session id as the stable task id with one default resource', () => {
  const session = newRecord('draft-1', '/repo', 0)
  const { migrated } = migrateSessionsToTasks([session])
  assert.equal(migrated, 1)
  assert.equal(session.taskId, 'draft-1', 'existing ids stay verbatim; no UI churn')
  assert.equal(session.resources?.length, 1)
  assert.match(session.resources?.[0].resourceId ?? '', /^res-/)
  assert.equal(session.resources?.[0].kind, 'muse')
  assert.equal(session.resources?.[0].generation, 0, 'nothing has spawned yet')
})

test('shell records migrate to shell resources', () => {
  const session = newRecord('draft-shell', '/repo', 0)
  session.terminalKind = 'shell'
  migrateSessionsToTasks([session])
  assert.equal(session.resources?.[0].kind, 'shell')
  assert.equal(defaultResourceFor({ terminalKind: 'shell' }).kind, 'shell')
})

test('migration is idempotent and preserves existing identity', () => {
  const session = newRecord('draft-2', '/repo', 0)
  migrateSessionsToTasks([session])
  const first = session.resources?.[0].resourceId
  const again = migrateSessionsToTasks([session])
  assert.equal(again.migrated, 0, 'second pass changes nothing')
  assert.equal(session.resources?.length, 1)
  assert.equal(session.resources?.[0].resourceId, first)
  // A bound provider session keeps its binding separate from local identity.
  session.resources![0].generation = 4
  session.resources![0].museId = 'muse-abc'
  ensureTaskIdentity(session)
  assert.equal(session.resources?.[0].generation, 4)
  assert.equal(session.resources?.[0].museId, 'muse-abc')
  assert.equal(session.taskId, 'draft-2')
})

test('migration counts only unmigrated records and launches nothing', () => {
  const fresh = newRecord('a', '/repo', 0)
  const done = newRecord('b', '/repo', 0)
  ensureTaskIdentity(done)
  assert.deepEqual(migrateSessionsToTasks([fresh, done]), { migrated: 1 })
  assert.equal(fresh.taskId, 'a')
  assert.equal(done.taskId, 'b')
})
