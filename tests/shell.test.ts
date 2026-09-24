import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shellExecutable } from '../server/launch'
import { MuseService } from '../server/service'
import type { MspClient } from '../server/msp'

test('shellExecutable prefers $SHELL and falls back to an installed shell', () => {
  const saved = process.env.SHELL
  try {
    process.env.SHELL = '/bin/sh'
    assert.equal(shellExecutable(), '/bin/sh')
    process.env.SHELL = '/nonexistent-shell-xyz'
    const fallback = shellExecutable()
    assert.ok(existsSync(fallback), `fallback shell must exist, got ${fallback}`)
    delete process.env.SHELL
    assert.ok(existsSync(shellExecutable()))
  } finally {
    if (saved === undefined) delete process.env.SHELL
    else process.env.SHELL = saved
  }
})

function shellHost() {
  return Object.assign(new EventEmitter(), {
    stop() {},
    async stopAndWait() {},
    forkClient() { return this },
    async start() { return { serverInfo: { version: 'test' } } },
    async request(method: string) {
      throw new Error(`Muse must not be contacted for shell terminals (got ${method})`)
    },
  }) as unknown as MspClient
}

test('newContext stores a shell kind only when requested', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-shell-kind-'))
  const service = new MuseService(dir, dir, shellHost())
  try {
    const shell = await service.invoke('newContext', { repo: dir, name: 'ops', terminalKind: 'shell', launch: {} })
    assert.equal(shell.terminalKind, 'shell')
    const muse = await service.invoke('newContext', { repo: dir, name: 'frontend', launch: {} })
    assert.equal(muse.terminalKind, 'muse')
    const bogus = await service.invoke('newContext', { repo: dir, name: 'backend', terminalKind: 'tui', launch: {} })
    assert.equal(bogus.terminalKind, 'muse')
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('shell terminalOpen skips Muse and passes the shell kind to the PTY layer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-shell-open-'))
  const service = new MuseService(dir, dir, shellHost())
  let opened: unknown[] = []
  const original = service.terminals.open.bind(service.terminals)
  service.terminals.open = (async (...args: unknown[]) => { opened = args; return { data: '', seq: 0, cols: 90, rows: 28, running: true } }) as typeof original
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'ops', terminalKind: 'shell', launch: {} })
    const snapshot = await service.invoke('terminalOpen', { id: context.id })
    assert.equal(opened[6], 'shell')
    assert.equal(snapshot.running, true)
    assert.equal(service.store.context(context.id).terminalRunning, true)
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('shell exit keeps the context without reading Muse history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-shell-exit-'))
  const service = new MuseService(dir, dir, shellHost())
  const original = service.terminals.open.bind(service.terminals)
  service.terminals.open = (async () => ({ data: '', seq: 0, cols: 90, rows: 28, running: true })) as typeof original
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'ops', terminalKind: 'shell', launch: {} })
    await service.invoke('terminalOpen', { id: context.id })
    service.terminals.emit('exit', { id: context.id, exitCode: 0 })
    assert.equal(service.store.state.contexts.find(c => c.id === context.id)?.terminalRunning, false)
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('removed chat actions stay unavailable, including on shell terminals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-shell-chat-'))
  const service = new MuseService(dir, dir, shellHost())
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'ops', terminalKind: 'shell', launch: {} })
    await assert.rejects(service.invoke('send', { id: context.id }), /not available for generic CLI agents/)
    await assert.rejects(service.invoke('fork', { id: context.id }), /not available for generic CLI agents/)
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})
