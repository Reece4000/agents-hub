import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeLaunch, wireApprovalMode, mspReasoningEffort, globalArguments, terminalArguments, DEFAULT_LAUNCH } from '../server/launch'
import { MuseService } from '../server/service'
import type { MspClient } from '../server/msp'

test('launch defaults to on-request without trust or yolo', () => {
  assert.deepEqual(normalizeLaunch(undefined), DEFAULT_LAUNCH)
  assert.deepEqual(normalizeLaunch({}), DEFAULT_LAUNCH)
})

test('launch normalization sanitizes unknown values and trims text', () => {
  const launch = normalizeLaunch({ model: '  m1  ', reasoningEffort: 'bogus', approvalMode: 'bogus', permissionProfile: '  prof  ', trustWorkspace: 1, yolo: 'yes' })
  assert.equal(launch.model, 'm1')
  assert.equal(launch.reasoningEffort, '')
  assert.equal(launch.approvalMode, 'on-request')
  assert.equal(launch.permissionProfile, 'prof')
  assert.equal(launch.trustWorkspace, false)
  assert.equal(launch.yolo, false)
  const checked = normalizeLaunch({ reasoningEffort: 'max', approvalMode: 'never', trustWorkspace: true, yolo: true })
  assert.equal(checked.reasoningEffort, 'max')
  assert.equal(checked.trustWorkspace, true)
  assert.equal(checked.yolo, true)
})

test('CLI approval modes map to MSP wire modes', () => {
  assert.equal(wireApprovalMode('never'), 'allowAll')
  assert.equal(wireApprovalMode('untrusted'), 'denyUnmatched')
  assert.equal(wireApprovalMode('on-request'), 'promptUnmatched')
})

test('max reasoning effort maps to ultra for MSP turns', () => {
  assert.equal(mspReasoningEffort('max'), 'ultra')
  assert.equal(mspReasoningEffort(''), undefined)
  assert.equal(mspReasoningEffort('low'), 'low')
})

test('terminal argv carries every launch flag before the workspace root', () => {
  const args = terminalArguments('session-1', '/repo', {
    model: 'm1', reasoningEffort: 'low', approvalMode: 'never',
    permissionProfile: 'prof', trustWorkspace: true, yolo: true,
  })
  assert.deepEqual(args, ['resume', 'session-1', '--model', 'm1', '--reasoning-effort', 'low', '--approval-mode', 'never', '--permission-profile', 'prof', '--trust-workspace', '--yolo', '--workspace', '/repo'])
  const minimal = terminalArguments('s', '/r', DEFAULT_LAUNCH)
  assert.deepEqual(minimal, ['resume', 's', '--approval-mode', 'on-request', '--workspace', '/r'])
  assert.deepEqual(globalArguments(DEFAULT_LAUNCH, '/r'), ['--approval-mode', 'on-request', '--workspace', '/r'])
})

test('newContext stores the name and launch flags', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-launch-'))
  const host = Object.assign(new EventEmitter(), { stop() {} }) as MspClient
  const service = new MuseService(dir, dir, host)
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'frontend', launch: { model: 'm1', reasoningEffort: 'low', approvalMode: 'never', permissionProfile: '', trustWorkspace: false, yolo: true } })
    assert.equal(context.name, 'frontend')
    assert.equal(context.launch.approvalMode, 'never')
    assert.equal(context.launch.yolo, true)
    assert.equal(context.launch.model, 'm1')
    assert.equal(context.launch.reasoningEffort, 'low')
    const cliOnly = await service.invoke('newContext', { repo: dir, name: 'backend', launch: { model: '', reasoningEffort: 'max', approvalMode: 'on-request', permissionProfile: '', trustWorkspace: false, yolo: false } })
    assert.equal(cliOnly.launch.reasoningEffort, 'max', 'the terminal keeps the real max flag')
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('newContext auto-names a blank name instead of failing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-launch-name-'))
  const host = Object.assign(new EventEmitter(), { stop() {} }) as MspClient
  const service = new MuseService(dir, dir, host)
  try {
    const first = await service.invoke('newContext', { repo: dir, launch: {} })
    assert.equal(first.name, 'Session 1')
    const second = await service.invoke('newContext', { repo: dir, name: '   ', launch: {} })
    assert.equal(second.name, 'Session 2')
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('opening a terminal never mints or resumes a server-side session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-launch-fresh-'))
  const methods: string[] = []
  const host = Object.assign(new EventEmitter(), {
    stop() {},
    async stopAndWait() {},
    async start() { return { serverInfo: { version: 'test' } } },
    async request(method: string) { methods.push(method); throw new Error(`contexts must not contact Muse (got ${method})`) },
  }) as unknown as MspClient
  const service = new MuseService(dir, dir, host)
  const original = service.terminals.open.bind(service.terminals)
  let opened: unknown[] = []
  service.terminals.open = (async (...args: unknown[]) => { opened = args; return { data: '', seq: 0, cols: 90, rows: 28, running: true } }) as typeof original
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'frontend', launch: { model: 'm1', reasoningEffort: '', approvalMode: 'never', permissionProfile: '', trustWorkspace: false, yolo: false } })
    await service.invoke('terminalOpen', { id: context.id })
    // Contexts own no Muse identity: every PTY boots bare `muse` and the TUI
    // owns whatever sessions it creates, so no MSP method may ever run here.
    assert.deepEqual(methods, [], 'no MSP method may run for a context terminal')
    assert.equal(opened[1], null, 'a context PTY always takes the bare-muse path, never resume')
    assert.equal(service.store.context(context.id).terminalRunning, true)
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('concurrent terminal opens share a single PTY spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-launch-singleflight-'))
  const host = Object.assign(new EventEmitter(), { stop() {} }) as MspClient
  const service = new MuseService(dir, dir, host)
  let spawns = 0
  const original = service.terminals.open.bind(service.terminals)
  service.terminals.open = (async () => { spawns++; await new Promise(r => setTimeout(r, 20)); return { data: '', seq: 0, cols: 90, rows: 28, running: true } }) as typeof original
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'frontend', launch: {} })
    await Promise.all([service.invoke('terminalOpen', { id: context.id }), service.invoke('terminalOpen', { id: context.id })])
    assert.equal(spawns, 1, 'racing opens must share one PTY spawn')
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('removed Muse session actions fail with a clear message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-launch-removed-'))
  const host = Object.assign(new EventEmitter(), { stop() {} }) as MspClient
  const service = new MuseService(dir, dir, host)
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'frontend' })
    for (const action of ['newSession', 'patchSession', 'read', 'leaveChat']) {
      await assert.rejects(service.invoke(action, { id: context.id }), /Provider sessions are managed inside their terminal/)
    }
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('terminal open reuses the stored launch flags', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-launch-term-'))
  const host = Object.assign(new EventEmitter(), {
    stop() {},
    async stopAndWait() {},
    async start() { return { serverInfo: { version: 'test' } } },
    async request(method: string) {
      throw new Error(`unexpected ${method}`)
    },
  }) as unknown as MspClient
  const service = new MuseService(dir, dir, host)
  let opened: unknown[] = []
  const original = service.terminals.open.bind(service.terminals)
  service.terminals.open = (async (...args: unknown[]) => { opened = args; return { data: '', seq: 0, cols: 90, rows: 28, running: true } }) as typeof original
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'frontend', launch: { model: '', reasoningEffort: '', approvalMode: 'untrusted', permissionProfile: '', trustWorkspace: true, yolo: false } })
    await service.invoke('terminalOpen', { id: context.id })
    const launch = (opened[5] ?? {}) as { approvalMode?: string; trustWorkspace?: boolean }
    assert.equal(launch.approvalMode, 'untrusted')
    assert.equal(launch.trustWorkspace, true)
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})
