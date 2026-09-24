import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSupervisor } from '../server/supervisor'
import { SupervisorClient } from '../server/supervisor-client'
import { HubService } from '../server/service'

const cat = { kind: 'custom' as const, profile: { label: 'cat', executable: '/bin/cat', args: [] }, cols: 80, rows: 24 }
const waitFor = async (check: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(resolve => setTimeout(resolve, 20)) } }

test('terminals outlive a disconnected app and reattach with their screen', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahs-'))
  const socket = join(dir, 's.sock')
  let exited = false
  const supervisor = await runSupervisor(socket, { idleMs: 200, onExit: () => { exited = true } })
  try {
    const first = await SupervisorClient.connect(socket, () => { throw new Error('should already be running') })
    let output = ''
    first.on('data', event => { output += event.data })
    const opened = await first.open('agent-1', dir, cat)
    assert.equal(opened.running, true)
    first.write('agent-1', 'survives-restart\r')
    await waitFor(() => output.includes('survives-restart'))
    first.close()
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(exited, false, 'a running terminal keeps the supervisor alive after the app disconnects')

    const second = await SupervisorClient.connect(socket, () => { throw new Error('should already be running') })
    assert.deepEqual(second.runningIds(), ['agent-1'], 'the reconnecting app learns what is still running')
    const snapshot = await second.open('agent-1', dir, cat)
    assert.ok(snapshot.data.includes('survives-restart'), 'reattaching restores the screen instead of respawning')
    let exitCode: number | undefined
    second.on('exit', event => { exitCode = event.exitCode })
    await second.stop('agent-1')
    await waitFor(() => exitCode !== undefined)
    assert.equal(second.running('agent-1'), false)
    second.close()
    await waitFor(() => exited, 2000)
    assert.equal(existsSync(socket), false, 'an idle supervisor exits and removes its socket')
  } finally { supervisor.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('connect starts a supervisor when none is listening', { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahs-'))
  const socket = join(dir, 's.sock')
  let supervisor: { close: () => void } | undefined
  try {
    const client = await SupervisorClient.connect(socket, () => { void runSupervisor(socket, { idleMs: 100, onExit: () => {} }).then(value => { supervisor = value }) })
    assert.deepEqual(client.runningIds(), [])
    client.close()
  } finally { supervisor?.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('the service adopts agents that kept running while the app was closed', { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahs-'))
  const socket = join(dir, 's.sock')
  const supervisor = await runSupervisor(socket, { idleMs: 100, onExit: () => {} })
  try {
    const first = new HubService(dir, dir, '', await SupervisorClient.connect(socket, () => {}))
    const context = await first.invoke('newContext', { repo: dir, name: 'ops', terminalKind: 'custom', profile: { label: 'Cat', executable: '/bin/cat', args: [] } })
    const id = context.terminals[0].id
    await first.invoke('terminalOpen', { id })
    first.close()
    const second = new HubService(dir, dir, '', await SupervisorClient.connect(socket, () => {}))
    assert.equal(second.store.resource(id).terminalRunning, false, 'stored state says stopped until adopted')
    second.adoptRunning()
    assert.equal(second.store.resource(id).terminalRunning, true)
    assert.deepEqual([second.activity.get(id)?.state, second.activity.get(id)?.detail], ['idle', 'Still running'])
    await second.invoke('terminalClose', { id })
    second.close()
  } finally { supervisor.close(); rmSync(dir, { recursive: true, force: true }) }
})
