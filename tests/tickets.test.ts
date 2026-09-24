import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TicketStore } from '../server/tickets'
import type { TicketSnapshot } from '../server/tickets'

const workspace = () => mkdtempSync(join(tmpdir(), 'agent-hub-tickets-'))

test('tickets are repo-local files, and external edits appear in watcher snapshots', async () => {
  const repo = workspace()
  const store = new TicketStore()
  try {
    const created = store.create(repo, { title: 'Check the handoff', status: 'ready', acceptance: ['Agent can read it'] })
    const second = store.create(repo, { title: 'Another handoff' })
    assert.notEqual(second.id, created.id)
    const file = join(repo, '.agents-hub', 'tickets', `${created.id}.json`)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).title, created.title)
    assert.ok(existsSync(join(repo, '.agents-hub', 'tickets', 'README.md')))
    const snapshot = new Promise<TicketSnapshot>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Ticket watcher did not report the external edit')), 3000)
      store.on('change', (value: TicketSnapshot) => {
        if (value.repo === repo && value.tickets[0]?.status === 'completed') { clearTimeout(timeout); resolve(value) }
      })
    })
    const temporary = `${file}.external.tmp`
    writeFileSync(temporary, JSON.stringify({ ...created, status: 'completed', updatedAt: new Date(Date.now() + 1000).toISOString() }))
    renameSync(temporary, file)
    assert.equal((await snapshot).tickets.find(ticket => ticket.id === created.id)?.status, 'completed')
  } finally { store.close(); rmSync(repo, { recursive: true, force: true }) }
})

test('stale board writes cannot overwrite an agent edit', () => {
  const repo = workspace()
  const store = new TicketStore()
  try {
    const created = store.create(repo, { title: 'Original' })
    const file = join(repo, '.agents-hub', 'tickets', `${created.id}.json`)
    const external = { ...created, title: 'Changed by agent', updatedAt: new Date(Date.now() + 1000).toISOString() }
    writeFileSync(file, JSON.stringify(external))
    assert.throws(() => store.update(repo, created.id, { title: 'Old editor value' }, created.updatedAt), /changed on disk/)
    assert.equal(store.list(repo)[0].title, 'Changed by agent')
    const updated = store.update(repo, created.id, { status: 'needs_testing' }, external.updatedAt)
    assert.equal(updated.title, 'Changed by agent')
    assert.equal(updated.status, 'needs_testing')
  } finally { store.close(); rmSync(repo, { recursive: true, force: true }) }
})

test('ticket paths and ticket files cannot escape through symlinks', () => {
  const repo = workspace()
  const outside = workspace()
  const store = new TicketStore()
  try {
    symlinkSync(outside, join(repo, '.agents-hub'))
    assert.throws(() => store.create(repo, { title: 'Escape' }), /must stay inside/)
    assert.equal(existsSync(join(outside, 'tickets')), false)
    rmSync(join(repo, '.agents-hub'))
    const ticket = store.create(repo, { title: 'Safe' })
    const file = join(repo, '.agents-hub', 'tickets', `${ticket.id}.json`)
    rmSync(file)
    const externalFile = join(outside, 'external.json')
    writeFileSync(externalFile, JSON.stringify(ticket))
    symlinkSync(externalFile, file)
    assert.throws(() => store.list(repo), /must not be a symlink/)
    assert.throws(() => store.update(repo, ticket.id, { status: 'completed' }), /must not be a symlink/)
    assert.equal(JSON.parse(readFileSync(externalFile, 'utf8')).status, 'backlog')
    rmSync(join(repo, '.agents-hub', 'tickets'), { recursive: true })
    symlinkSync(outside, join(repo, '.agents-hub', 'tickets'))
    assert.throws(() => store.update(repo, ticket.id, { title: 'Escape' }), /must stay inside/)
    rmSync(join(repo, '.agents-hub', 'tickets'))
    mkdirSync(join(repo, '.agents-hub', 'tickets'))
    symlinkSync(join(outside, 'missing.md'), join(repo, '.agents-hub', 'tickets', 'README.md'))
    assert.throws(() => store.list(repo), /guide must not be a symlink/)
    assert.equal(existsSync(join(outside, 'missing.md')), false)
  } finally { store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})
