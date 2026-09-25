import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shellExecutable } from '../server/provider-profiles'
import { HubService } from '../server/service'
import type { OpenSpec } from '../server/terminals'

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

test('shell terminalOpen passes the shell kind to the PTY layer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-shell-open-'))
  const service = new HubService(dir, dir)
  let spec: OpenSpec | undefined
  service.terminals.open = (async (_id: string, _repo: string, next: OpenSpec) => { spec = next; return { data: '', seq: 0, cols: 90, rows: 28, running: true } }) as typeof service.terminals.open
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'ops', terminalKind: 'shell' })
    const snapshot = await service.invoke('terminalOpen', { id: context.id })
    assert.equal(spec?.kind, 'shell')
    assert.equal(snapshot.running, true)
    assert.equal(service.store.context(context.id).terminals[0].terminalRunning, true)
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('shell exit keeps the context and marks the terminal stopped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-shell-exit-'))
  const service = new HubService(dir, dir)
  service.terminals.open = (async () => ({ data: '', seq: 0, cols: 90, rows: 28, running: true })) as typeof service.terminals.open
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'ops', terminalKind: 'shell' })
    await service.invoke('terminalOpen', { id: context.id })
    service.terminals.emit('exit', { id: context.terminals[0].id, exitCode: 0 })
    assert.equal(service.store.state.contexts.find(c => c.id === context.id)?.terminals[0].terminalRunning, false)
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})
