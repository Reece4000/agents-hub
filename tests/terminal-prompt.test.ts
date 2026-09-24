import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTerminalPrompt, bracketedPaste, quoteTerminalPath } from '../src/terminalPrompt'
import { HubService } from '../server/service'

test('terminal prompt escapes paths like a terminal drop and appends attachment refs', () => {
  assert.equal(quoteTerminalPath('/tmp/a b.png'), '/tmp/a\\ b.png')
  assert.equal(quoteTerminalPath("/tmp/q'x (1).png"), "/tmp/q\\'x\\ \\(1\\).png")
  assert.equal(quoteTerminalPath('/Users/me/Library/Application Support/Agent Hub/a.png'), '/Users/me/Library/Application\\ Support/Agent\\ Hub/a.png')
  assert.equal(buildTerminalPrompt('  hello  ', []), 'hello\n')
  assert.equal(buildTerminalPrompt('', []), '')
  const payload = buildTerminalPrompt('review this', [
    { id: 'a', name: 'shot.png', mime: 'image/png', size: 3, path: '/tmp/shot.png' },
    { id: 'b', name: 'notes.txt', mime: 'text/plain', size: 3, path: '/tmp/notes.txt' },
    { id: 'c', name: 'unsaved.png', mime: 'image/png', size: 3 },
  ])
  assert.equal(payload, 'review this\n/tmp/shot.png\n/tmp/notes.txt\n')
})

test('bracketed paste wraps the payload for one-shot multiline delivery', () => {
  assert.equal(bracketedPaste('a\nb'), '\x1b[200~a\nb\x1b[201~')
})

test('attachment path resolves only for draft members', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-attachment-path-'))
  const service = new HubService(dir, dir)
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'frontend' })
    const id = context.terminals[0].id
    const saved = service.saveAttachment({ name: 'shot.png', mime: 'image/png', base64: Buffer.from('img').toString('base64') })
    assert.ok(saved.path)
    await service.invoke('patchTerminal', { id, patch: { draft: { html: '<p>x</p>', text: 'x', attachments: [saved] } } })
    const resolved = await service.invoke('attachmentPath', { id, attachmentId: saved.id })
    assert.ok(String(resolved).endsWith(saved.id))
    await assert.rejects(service.invoke('attachmentPath', { id, attachmentId: 'nope' }), /no longer/)
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})
