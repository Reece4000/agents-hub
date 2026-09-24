import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HubService } from '../server/service'
import { Store } from '../server/store'
import { Terminals } from '../server/terminals'

test('typing a 100-key draft does not broadcast or synchronously serialize the entire workspace per key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-typing-'))
  const service = new HubService(dir, dir)
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'frontend' })
    const id = context.terminals[0].id
    let writes = 0, broadcasts = 0
    service.store.save = () => { writes++ }
    service.on('workspace', () => { broadcasts++ })
    await new Promise(resolve => setTimeout(resolve, 200))
    writes = 0; broadcasts = 0
    for (let i = 1; i <= 100; i++) await service.invoke('patchTerminal', { id, patch: { draft: { html: `<p>${'a'.repeat(i)}</p>`, text: 'a'.repeat(i), attachments: [] } } })
    assert.equal(service.store.resource(id).draft.text.length, 100)
    assert.equal(broadcasts, 0, 'typing must remain local to the composer')
    assert.ok(writes <= 1, `100 keystrokes caused ${writes} full-store writes`)
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('contexts survive terminal exits and restarts, even when empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-keep-'))
  const service = new HubService(dir, dir)
  service.terminals.open = (async () => ({ data: '', seq: 0, cols: 90, rows: 28, running: true })) as typeof service.terminals.open
  try {
    // Only an explicit delete removes a context: empty drafts, closed
    // terminals, and restarts all keep it.
    const context = await service.invoke('newContext', { repo: dir, name: 'backend' })
    await service.invoke('terminalOpen', { id: context.id })
    service.terminals.emit('exit', { id: context.terminals[0].id, exitCode: 0 })
    assert.equal(service.store.state.contexts.length, 1)
    service.close()
    const restored = new Store(dir, dir)
    assert.equal(restored.state.contexts.length, 1)
    assert.equal(restored.state.contexts[0].name, 'backend')
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('PTY burst input survives and reattaching restores its existing screen', { timeout: 5000 }, async () => {
  const terminals = new Terminals()
  const spec = { kind: 'custom' as const, profile: { label: 'cat', executable: '/bin/cat', args: [] }, cols: 100, rows: 30 }
  try {
    await terminals.open('test', '/tmp', spec)
    const marker = 'NO-DROPPED-KEYS-' + Array.from({ length: 200 }, (_, i) => i % 10).join('')
    const output = new Promise<void>(resolve => { let all = ''; terminals.on('data', e => { all += e.data; if (all.includes(marker)) resolve() }) })
    for (const character of marker) terminals.write('test', character)
    terminals.write('test', '\r'); await output
    const screen = await terminals.open('test', '/tmp', spec)
    assert.ok(screen.data.includes('NO-DROPPED-KEYS-'))
    assert.equal(screen.running, true)
    await terminals.stop('test'); assert.equal(terminals.running('test'), false)
  } finally { terminals.close() }
})

test('an agent terminal without a command is refused before spawning', async () => {
  const terminals = new Terminals()
  try { await assert.rejects(terminals.open('none', '/tmp', { kind: 'codex' }), /Choose a command/) }
  finally { terminals.close() }
})

test('renaming a context persists and survives reopening', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-rename-'))
  const service = new HubService(dir, dir)
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'frontend' })
    await service.invoke('patchContext', { id: context.id, patch: { name: '  web  ' } })
    assert.equal(service.store.context(context.id).name, 'web')
    service.close()
    assert.equal(new Store(dir, dir).state.contexts[0].name, 'web')
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('deleting a running context stops its PTY instead of hiding it while it runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-delete-stop-'))
  const service = new HubService(dir, dir)
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'infra' })
    service.store.context(context.id).terminals[0].terminalRunning = true
    let stopped: string | null = null
    service.terminals.stop = async (id: string) => { stopped = id }
    await service.invoke('deleteContext', { id: context.id })
    assert.equal(stopped, context.terminals[0].id)
    assert.equal(service.store.state.contexts.length, 0)
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('deleteContext removes the context without waiting for PTY death', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-delete-fast-'))
  const service = new HubService(dir, dir)
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'frontend' })
    service.store.context(context.id).terminals[0].terminalRunning = true
    let stopCalled: string | null = null
    // A TUI mid-run can take seconds to shut down; the delete response (and
    // the tab removal it drives) must not wait on it.
    service.terminals.stop = ((id: string) => { stopCalled = id; return new Promise(() => {}) }) as typeof service.terminals.stop
    await Promise.race([
      service.invoke('deleteContext', { id: context.id }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('deleteContext waited for PTY death')), 3000)),
    ])
    assert.equal(stopCalled, context.terminals[0].id, 'shutdown is still initiated')
    assert.equal(service.store.state.contexts.length, 0)
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('draft saves retain attachment metadata without copying image bytes on every keystroke', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-images-')), service = new HubService(dir, dir)
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'frontend' })
    const id = context.terminals[0].id
    const a = service.saveAttachment({ name: 'fixture.png', mime: 'image/png', base64: Buffer.alloc(1024 * 1024, 7).toString('base64') })
    await service.invoke('patchTerminal', { id, patch: { draft: { html: '<p>Image</p>', text: 'Image', attachments: [a] } } })
    assert.equal(service.store.resource(id).draft.attachments[0].preview, undefined)
    assert.equal(await service.invoke('attachmentPreview', { id: a.id, mime: a.mime }), a.preview)
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('saved attachments keep a file extension so agents recognize their type', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-attachment-ext-')), service = new HubService(dir, dir)
  try {
    assert.match(service.saveAttachment({ name: 'shot.PNG', mime: 'image/png', base64: 'aGk=' }).path!, /\.png$/)
    assert.match(service.saveAttachment({ name: 'Screenshot', mime: 'image/jpeg', base64: 'aGk=' }).path!, /\.jpg$/)
    assert.doesNotMatch(service.saveAttachment({ name: 'notes', mime: 'application/x-unknown', base64: 'aGk=' }).path!, /\.[a-z]+$/)
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('a terminal screen reads as plain text for prompt detection', { timeout: 5000 }, async () => {
  const terminals = new Terminals()
  try {
    await terminals.open('p', '/tmp', { kind: 'custom', profile: { label: 'printf', executable: '/usr/bin/printf', args: ['\x1b[2J\x1b[3;5HYes, I trust\x1b[3;18Hthis folder\\n'] }, cols: 60, rows: 10 })
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.match(await terminals.peek('p'), /Yes, I trust this folder/)
  } finally { terminals.close() }
})
