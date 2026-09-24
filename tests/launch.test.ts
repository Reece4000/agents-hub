import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HubService } from '../server/service'
import type { OpenSpec } from '../server/terminals'

const withService = async (name: string, run: (service: HubService, dir: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), `agent-hub-${name}-`))
  const service = new HubService(dir, dir)
  try { await run(service, dir) } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
}
const stubOpen = (service: HubService) => {
  const calls: { id: string; repo: string; spec: OpenSpec }[] = []
  service.terminals.open = (async (id: string, repo: string, spec: OpenSpec) => { calls.push({ id, repo, spec }); return { data: '', seq: 0, cols: 90, rows: 28, running: true } }) as typeof service.terminals.open
  return calls
}

test('newContext auto-names a blank name instead of failing', () => withService('launch-name', async (service, dir) => {
  const first = await service.invoke('newContext', { repo: dir })
  assert.equal(first.name, 'Session 1')
  const second = await service.invoke('newContext', { repo: dir, name: '   ' })
  assert.equal(second.name, 'Session 2')
}))

test('a terminal without a known kind starts as a shell', () => withService('launch-default', async (service, dir) => {
  const context = await service.invoke('newContext', { repo: dir, name: 'frontend', terminalKind: 'retired' })
  assert.equal(context.terminals[0].terminalKind, 'shell')
  assert.equal(context.terminals[0].profile, undefined)
}))

test('a custom agent opens with its executable, argv, and board environment', () => withService('launch-custom', async (service, dir) => {
  const calls = stubOpen(service)
  const context = await service.invoke('newContext', { repo: dir, name: 'frontend', terminalKind: 'custom', profile: { label: 'Env', executable: '/usr/bin/env', args: ['--help'] } })
  await service.invoke('terminalOpen', { id: context.terminals[0].id })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].repo, dir)
  assert.equal(calls[0].spec.kind, 'custom')
  assert.deepEqual(calls[0].spec.profile, { label: 'Env', executable: '/usr/bin/env', args: ['--help'] })
  assert.equal(calls[0].spec.env?.AGENT_HUB_REPO, dir)
  assert.equal(service.store.resource(context.terminals[0].id).terminalRunning, true)
}))

test('concurrent terminal opens share a single PTY spawn', () => withService('launch-singleflight', async (service, dir) => {
  let spawns = 0
  service.terminals.open = (async () => { spawns++; await new Promise(r => setTimeout(r, 20)); return { data: '', seq: 0, cols: 90, rows: 28, running: true } }) as typeof service.terminals.open
  const context = await service.invoke('newContext', { repo: dir, name: 'frontend' })
  await Promise.all([service.invoke('terminalOpen', { id: context.id }), service.invoke('terminalOpen', { id: context.id })])
  assert.equal(spawns, 1, 'racing opens must share one PTY spawn')
}))

test('retired chat actions are unknown', () => withService('launch-removed', async service => {
  for (const action of ['newSession', 'send', 'approval']) await assert.rejects(service.invoke(action), /Unknown action/)
}))
