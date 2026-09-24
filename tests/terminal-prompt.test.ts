import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTerminalPrompt, bracketedPaste, formatComposerSummary, quoteTerminalPath } from '../src/terminalPrompt'
import { MuseService } from '../server/service'
import type { MspClient } from '../server/msp'

test('terminal prompt quotes paths and appends attachment refs', () => {
  assert.equal(quoteTerminalPath('/tmp/a b.png'), '@"/tmp/a b.png"')
  assert.equal(quoteTerminalPath('/tmp/q"x.png'), '@"/tmp/q\\"x.png"')
  assert.equal(buildTerminalPrompt('  hello  ', []), 'hello\n')
  assert.equal(buildTerminalPrompt('', []), '')
  const payload = buildTerminalPrompt('review this', [
    { id: 'a', name: 'shot.png', mime: 'image/png', size: 3, path: '/tmp/shot.png' },
    { id: 'b', name: 'notes.txt', mime: 'text/plain', size: 3, path: '/tmp/notes.txt' },
    { id: 'c', name: 'unsaved.png', mime: 'image/png', size: 3 },
  ])
  assert.equal(payload, 'review this\n@"/tmp/shot.png"\n@"/tmp/notes.txt"\n')
})

test('bracketed paste wraps the payload for one-shot multiline delivery', () => {
  assert.equal(bracketedPaste('a\nb'), '\x1b[200~a\nb\x1b[201~')
})

test('composer summary always shows effort and flags, never just the model', () => {
  assert.equal(formatComposerSummary({ terminalKind: 'shell', launch: undefined } as never), 'Shell')
  assert.equal(
    formatComposerSummary({ launch: undefined } as never),
    'default model · default effort · approval on-request',
  )
  assert.equal(
    formatComposerSummary({ launch: { model: '', reasoningEffort: '', approvalMode: 'on-request', permissionProfile: '', trustWorkspace: false, yolo: false } } as never),
    'default model · default effort · approval on-request',
  )
  assert.equal(
    formatComposerSummary({ launch: { model: 'm1', reasoningEffort: 'max', approvalMode: 'never', permissionProfile: '', trustWorkspace: false, yolo: false } } as never),
    'm1 · max · approval never',
  )
  assert.equal(
    formatComposerSummary({ launch: { model: 'm1', reasoningEffort: 'high', approvalMode: 'on-request', permissionProfile: 'prof', trustWorkspace: true, yolo: false } } as never),
    'm1 · high · approval on-request · profile prof · trusted',
  )
  assert.equal(
    formatComposerSummary({ launch: { model: 'm1', reasoningEffort: 'high', approvalMode: 'on-request', permissionProfile: '', trustWorkspace: true, yolo: true } } as never),
    'm1 · high · approval on-request · yolo',
  )
})

test('launch patch rejects while the terminal runs and applies after close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-launch-patch-'))
  const host = Object.assign(new EventEmitter(), {
    stop() {},
    async start() { return { serverInfo: { version: 'test' } } },
    async request(method: string) {
      throw new Error(`unexpected ${method}`)
    },
  }) as unknown as MspClient
  const service = new MuseService(dir, dir, host)
  const original = service.terminals.open.bind(service.terminals)
  service.terminals.open = (async () => ({ data: '', seq: 0, cols: 90, rows: 28, running: true })) as typeof original
  const running = service.terminals.running.bind(service.terminals)
  service.terminals.running = (() => true) as typeof running
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'frontend', launch: {} })
    await service.invoke('terminalOpen', { id: context.id })
    await assert.rejects(service.invoke('patchContext', { id: context.id, patch: { launch: { model: 'm2' } } }), /Stop the terminal/)
    service.terminals.running = running
    await service.invoke('terminalClose', { id: context.id })
    const updated = await service.invoke('patchContext', { id: context.id, patch: { launch: { model: 'm2', reasoningEffort: 'low' } } })
    assert.equal(updated.launch.model, 'm2')
    assert.equal(updated.launch.reasoningEffort, 'low')
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('attachment path resolves only for draft members', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-attachment-path-'))
  const service = new MuseService(dir, dir)
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'frontend' })
    const saved = service.saveAttachment({ name: 'shot.png', mime: 'image/png', base64: Buffer.from('img').toString('base64') })
    assert.ok(saved.path)
    await service.invoke('patchContext', { id: context.id, patch: { draft: { html: '<p>x</p>', text: 'x', attachments: [saved] } } })
    const resolved = await service.invoke('attachmentPath', { id: context.id, attachmentId: saved.id })
    assert.ok(String(resolved).endsWith(saved.id))
    await assert.rejects(service.invoke('attachmentPath', { id: context.id, attachmentId: 'nope' }), /no longer/)
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})
