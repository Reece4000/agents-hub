import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { v7 as uuid } from 'uuid'
import { MspClient } from '../server/msp'
import type { SessionReadResult, SessionStartResult } from '../server/generated/msp'

test('real Muse: started session id persists across host restart', { timeout: 25000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-echo-'))
  const env = { XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data') }
  const client = new MspClient({ env })
  let second: MspClient | undefined
  try {
    await client.start()
    const result = await client.request<SessionStartResult>('session/start', { commandId: uuid(), workspaceRoot: dir, approvalMode: 'promptUnmatched' })
    const id = result.session.sessionId
    assert.ok(id)
    await client.stopAndWait()
    second = new MspClient({ env })
    await second.start()
    const restored = await second.request<SessionReadResult>('session/read', { sessionId: id, excludeItems: true })
    assert.equal(restored.session.sessionId, id)
  } finally { client.stop(); second?.stop(); rmSync(dir, { recursive: true, force: true }) }
})
