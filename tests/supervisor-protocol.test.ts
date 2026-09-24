import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SUPERVISOR_METHODS,
  SUPERVISOR_PROTOCOL_VERSION,
  isStaleGeneration,
  negotiateSupervisorVersion,
  parseSupervisorFrame,
} from '../server/supervisor-protocol'

test('protocol version is pinned and methods are closed', () => {
  assert.equal(SUPERVISOR_PROTOCOL_VERSION, 1)
  assert.deepEqual([...SUPERVISOR_METHODS], ['hello', 'open', 'attach', 'input', 'resize', 'stop', 'list', 'shutdown'])
})

test('valid request, response, and event frames parse', () => {
  const request = parseSupervisorFrame({ v: 1, id: 7, method: 'attach', params: { resourceId: 'res-1' } })
  assert.equal(request.v, 1)
  assert.deepEqual(request, { v: 1, id: 7, method: 'attach', params: { resourceId: 'res-1' } })
  assert.deepEqual(parseSupervisorFrame({ v: 1, id: 7, method: 'list' }), { v: 1, id: 7, method: 'list' })
  assert.deepEqual(parseSupervisorFrame({ v: 1, id: 8, ok: true, result: { running: true } }), { v: 1, id: 8, ok: true, result: { running: true } })
  assert.deepEqual(
    parseSupervisorFrame({ v: 1, id: 9, ok: false, error: { code: 'unknown-resource', message: 'gone' } }),
    { v: 1, id: 9, ok: false, error: { code: 'unknown-resource', message: 'gone' } },
  )
  assert.deepEqual(
    parseSupervisorFrame({ v: 1, event: 'data', resourceId: 'res-1', generation: 2, data: 'hi', seq: 4 }),
    { v: 1, event: 'data', resourceId: 'res-1', generation: 2, data: 'hi', seq: 4 },
  )
  assert.deepEqual(
    parseSupervisorFrame({ v: 1, event: 'exit', resourceId: 'res-1', generation: 2, exitCode: 1 }),
    { v: 1, event: 'exit', resourceId: 'res-1', generation: 2, exitCode: 1 },
  )
})

test('malformed frames fail with a coded error, never silently', () => {
  const cases: unknown[] = [
    null,
    'hello',
    [],
    { v: 2, id: 1, method: 'list' },
    { v: 1, id: 1.5, method: 'list' },
    { v: 1, id: 1, method: 'broadcast' },
    { v: 1, id: 1, method: 'list', params: 'nope' },
    { v: 1, id: 1, ok: false, error: { message: 'missing code' } },
    { v: 1, event: 'data', generation: 0, data: 'x', seq: 0 },
    { v: 1, event: 'data', resourceId: 'r', generation: -1, data: 'x', seq: 0 },
    { v: 1, event: 'data', resourceId: 'r', generation: 0, data: 'x', seq: 0.5 },
    { v: 1, event: 'exit', resourceId: 'r', generation: 0 },
    { v: 1, event: 'restart', resourceId: 'r', generation: 0 },
    { v: 1, id: 3 },
  ]
  for (const frame of cases) {
    let code: unknown
    try {
      parseSupervisorFrame(frame)
    } catch (error) {
      code = (error as { code?: unknown }).code
    }
    assert.equal(typeof code, 'string', `frame must fail with a coded error: ${JSON.stringify(frame)}`)
  }
  assert.throws(() => parseSupervisorFrame({ v: 2, id: 1, method: 'list' }), /version/i)
})

test('hello negotiates the highest shared version or refuses', () => {
  assert.equal(negotiateSupervisorVersion([1]), 1)
  assert.equal(negotiateSupervisorVersion([2, 1]), 1)
  for (const offered of [[], [2], '1', null, undefined]) {
    assert.throws(() => negotiateSupervisorVersion(offered), /version/i)
  }
})

test('stale generations are ignored, equal-or-newer apply', () => {
  assert.equal(isStaleGeneration(3, 2), true)
  assert.equal(isStaleGeneration(0, 0), false)
  assert.equal(isStaleGeneration(2, 2), false)
  assert.equal(isStaleGeneration(2, 5), false)
})
