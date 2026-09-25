import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Terminals } from '../server/terminals'
import { HubService } from '../server/service'
import type { RepoContext, Workspace } from '../src/types'

test('closing a terminal whose process ignores SIGTERM escalates to SIGKILL', { timeout: 15000 }, async () => {
  const terminals = new Terminals()
  const profile = { label: 'stubborn', executable: process.execPath, args: ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('READY'); setInterval(() => {}, 1000);"] }
  try {
    let output = ''
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('PTY produced no output before close')), 5000)
      terminals.on('data', (event: { data: string }) => {
        output += event.data
        if (output.includes('READY')) { clearTimeout(timer); resolve() }
      })
    })
    await terminals.open('stubborn', tmpdir(), { kind: 'custom', profile, cols: 80, rows: 24 })
    // The READY write proves the SIGTERM trap is installed, so SIGTERM alone cannot kill it.
    await ready
    await terminals.stop('stubborn')
    assert.equal(terminals.running('stubborn'), false)
  } finally { terminals.close() }
})

function waitForContext(service: HubService, id: string, timeoutMs = 3000): Promise<RepoContext> {
  return new Promise<RepoContext>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the terminal-closed broadcast')), timeoutMs)
    service.on('workspace', (workspace: Workspace) => {
      const context = workspace.contexts.find(item => item.id === id)
      if (context && context.terminals.every(terminal => !terminal.terminalRunning)) { clearTimeout(timer); resolve(context) }
    })
  })
}

test('a terminal exit broadcasts immediately', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-terminal-close-'))
  const service = new HubService(dir, dir)
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'frontend' })
    service.store.context(context.id).terminals[0].terminalRunning = true
    const broadcast = waitForContext(service, context.id)
    service.terminals.emit('exit', { id: context.terminals[0].id, exitCode: 0 })
    const closed = await broadcast
    assert.equal(closed.terminals[0].terminalRunning, false)
    assert.equal(service.store.context(context.id).terminals[0].terminalRunning, false)
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('workspace broadcasts carry live running state so the terminal view mounts', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-wire-running-'))
  const service = new HubService(dir, dir)
  const original = service.terminals.open.bind(service.terminals)
  service.terminals.open = (async () => ({ data: '', seq: 0, cols: 90, rows: 28, running: true })) as typeof original
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'frontend' })
    const broadcast = new Promise<import('../src/types').Workspace>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no workspace broadcast after open')), 3000)
      service.on('workspace', (workspace: import('../src/types').Workspace) => {
        if (workspace.contexts.some(c => c.id === context.id && c.terminals[0].terminalRunning)) { clearTimeout(timer); resolve(workspace) }
      })
    })
    await service.invoke('terminalOpen', { id: context.id })
    await broadcast
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('a shell exit with an unsent draft still broadcasts instead of going silent', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-shell-close-'))
  const service = new HubService(dir, dir)
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'ops', terminalKind: 'shell' })
    await service.invoke('patchTerminal', { id: context.terminals[0].id, patch: { draft: { html: '<p>Keep</p>', text: 'Keep', attachments: [] } } })
    service.store.context(context.id).terminals[0].terminalRunning = true
    const broadcast = waitForContext(service, context.id)
    service.terminals.emit('exit', { id: context.terminals[0].id, exitCode: 0 })
    await broadcast
    const stored = service.store.context(context.id).terminals[0]
    assert.equal(stored.terminalRunning, false)
    assert.equal(stored.draft.text, 'Keep')
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})
