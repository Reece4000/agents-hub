import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { MuseService } from '../server/service'
import type { MspClient } from '../server/msp'

function serviceIn(dir: string) {
  const host = Object.assign(new EventEmitter(), { stop() {} }) as MspClient
  return new MuseService(dir, dir, host)
}

test('listDir returns directories only, sorted, including hidden ones', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-hub-browser-'))
  const service = serviceIn(mkdtempSync(join(tmpdir(), 'agent-hub-browser-store-')))
  try {
    mkdirSync(join(root, 'zebra'))
    mkdirSync(join(root, 'apple'))
    mkdirSync(join(root, '.hidden'))
    writeFileSync(join(root, 'file.txt'), 'x')
    const listing = (await service.invoke('listDir', { path: root })) as { path: string; home: string; entries: { name: string; path: string }[] }
    assert.equal(listing.path, root)
    assert.deepEqual(listing.entries.map(e => e.name), ['.hidden', 'apple', 'zebra'])
    assert.ok(listing.entries.every(e => e.path.startsWith(root)))
  } finally { service.close(); rmSync(root, { recursive: true, force: true }) }
})

test('listDir defaults to home and resolves nested paths', async () => {
  const service = serviceIn(mkdtempSync(join(tmpdir(), 'agent-hub-browser-home-')))
  try {
    const listing = (await service.invoke('listDir', {})) as { path: string; home: string; entries: unknown[] }
    assert.equal(listing.path, homedir())
    assert.equal(listing.home, homedir())
    assert.ok(Array.isArray(listing.entries))
  } finally { service.close() }
})

test('listDir rejects relative and unreadable paths', async () => {
  const service = serviceIn(mkdtempSync(join(tmpdir(), 'agent-hub-browser-bad-')))
  try {
    await assert.rejects(service.invoke('listDir', { path: 'relative/path' }), /Invalid folder/)
    await assert.rejects(service.invoke('listDir', { path: join(tmpdir(), 'agent-hub-no-such-dir-xyz') }), /Cannot read/)
  } finally { service.close() }
})

test('selecting a folder records nothing; creating a context makes it known', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-browser-visit-'))
  const service = serviceIn(dir)
  try {
    const before = [...service.store.state.repos]
    await service.invoke('selectRepo', { repo: tmpdir() })
    assert.deepEqual(service.store.state.repos, before)
    assert.equal(service.store.state.selectedRepo, tmpdir())
    await service.invoke('newContext', { repo: tmpdir(), name: 'probe', launch: {} })
    assert.ok(service.store.state.repos.includes(tmpdir()))
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('listDir follows symlinked directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-hub-browser-link-'))
  const service = serviceIn(mkdtempSync(join(tmpdir(), 'agent-hub-browser-link-store-')))
  try {
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'alias'))
    const listing = (await service.invoke('listDir', { path: root })) as { entries: { name: string }[] }
    assert.deepEqual(listing.entries.map(e => e.name).sort(), ['alias', 'real'])
  } finally { service.close(); rmSync(root, { recursive: true, force: true }) }
})
