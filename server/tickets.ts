import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { v7 as uuid } from 'uuid'
import type { Ticket, TicketPriority, TicketStatus } from '../src/types'

const STATUSES: TicketStatus[] = ['backlog', 'planning', 'ready', 'in_progress', 'needs_testing', 'blocked', 'completed']
const PRIORITIES: TicketPriority[] = ['low', 'normal', 'high', 'urgent']
const validId = (id: unknown): id is string => typeof id === 'string' && /^AH-[A-F0-9]{8}$/.test(id)
const clean = (value: unknown, limit: number) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
const stringList = (value: unknown) => Array.isArray(value) ? value.slice(0, 30).map(v => clean(v, 500)).filter(Boolean) : []

export interface TicketSnapshot { repo: string; tickets: Ticket[]; error?: string }

/** Repo-local JSON tickets are intentionally plain files: terminals and other
 *  agents can read or update the same records without a Hub API client. */
export class TicketStore extends EventEmitter {
  private watchers = new Map<string, FSWatcher>()
  private timers = new Map<string, NodeJS.Timeout>()
  private pollers = new Map<string, NodeJS.Timeout>()
  private snapshots = new Map<string, string>()

  private directory(repo: string) { return join(resolve(repo), '.agents-hub', 'tickets') }

  private ensure(repo: string) {
    const root = resolve(repo)
    const directory = this.directory(root)
    for (const path of [join(root, '.agents-hub'), directory]) {
      if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('The ticket folder must stay inside this workspace.')
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    // Do not follow a repo-provided symlink out of the selected workspace.
    const realRoot = realpathSync(root)
    const resolvedDirectory = realpathSync(directory)
    if (resolvedDirectory !== realRoot && !resolvedDirectory.startsWith(`${realRoot}${sep}`)) throw new Error('The ticket folder must stay inside this workspace.')
    const guide = join(directory, 'README.md')
    if (lstatSync(guide, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('The ticket guide must not be a symlink.')
    if (!existsSync(guide)) {
      writeFileSync(guide, [
        '# Agent Hub workspace tickets',
        '',
        'Each `AH-*.json` file is one ticket. Read these files directly from any agent terminal.',
        'Update `status`, `priority`, `description`, `acceptance`, `agent`, or `contextId` in the ticket file to keep the board in sync.',
        '',
        'Valid statuses: `backlog`, `planning`, `ready`, `in_progress`, `needs_testing`, `blocked`, `completed`.',
        'Valid priorities: `low`, `normal`, `high`, `urgent`.',
        'Keep the ticket `id` and `createdAt` unchanged. Set `updatedAt` to an ISO timestamp when editing.',
        'A `contextId` is optional; `contextName` is a readable snapshot of the assigned terminal group.',
        '',
      ].join('\n'), { mode: 0o600 })
    }
    return directory
  }

  private file(repo: string, id: string) {
    if (!validId(id)) throw new Error('This ticket ID is invalid.')
    return join(this.directory(repo), `${id}.json`)
  }

  private readFile(file: string): Ticket {
    if (lstatSync(file).isSymbolicLink()) throw new Error(`The ticket file ${basename(file)} must not be a symlink.`)
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<Ticket>
    if (!validId(value.id) || basename(file) !== `${value.id}.json` || !clean(value.title, 160)) throw new Error(`The ticket file ${basename(file)} needs a valid ID and title.`)
    if (!STATUSES.includes(value.status as TicketStatus)) throw new Error(`The ticket file ${basename(file)} has an unknown status.`)
    if (!PRIORITIES.includes(value.priority as TicketPriority)) throw new Error(`The ticket file ${basename(file)} has an unknown priority.`)
    return {
      id: value.id,
      title: clean(value.title, 160),
      status: value.status as TicketStatus,
      priority: value.priority as TicketPriority,
      description: clean(value.description, 60000),
      acceptance: stringList(value.acceptance),
      agent: clean(value.agent, 120),
      contextId: clean(value.contextId, 120),
      contextName: clean(value.contextName, 120),
      createdAt: clean(value.createdAt, 40) || new Date(0).toISOString(),
      updatedAt: clean(value.updatedAt, 40) || new Date(0).toISOString(),
    }
  }

  list(repo: string): Ticket[] {
    const directory = this.ensure(repo)
    return readdirSync(directory)
      .filter((file: string) => /^AH-[A-F0-9]{8}\.json$/.test(file))
      .map((file: string) => this.readFile(join(directory, file)))
      .sort((a: Ticket, b: Ticket) => b.updatedAt.localeCompare(a.updatedAt))
  }

  watchRepo(repo: string) {
    const root = resolve(repo)
    if (this.watchers.has(root) || this.pollers.has(root)) return
    const directory = this.ensure(root)
    try { this.snapshots.set(root, JSON.stringify(this.list(root))) } catch { this.snapshots.set(root, '') }
    const publish = () => {
      try {
        const tickets = this.list(root)
        const signature = JSON.stringify(tickets)
        if (signature === this.snapshots.get(root)) return
        this.snapshots.set(root, signature)
        this.emit('change', { repo: root, tickets } satisfies TicketSnapshot)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === this.snapshots.get(root)) return
        this.snapshots.set(root, message)
        this.emit('change', { repo: root, tickets: [], error: message } satisfies TicketSnapshot)
      }
    }
    const poll = () => {
      if (this.pollers.has(root)) return
      const timer = setInterval(publish, 500)
      timer.unref()
      this.pollers.set(root, timer)
    }
    try {
      const watcher = watch(directory, () => {
        clearTimeout(this.timers.get(root))
        const timer = setTimeout(() => {
          this.timers.delete(root)
          publish()
        }, 80)
        this.timers.set(root, timer)
      })
      watcher.on('error', error => {
        watcher.close()
        this.watchers.delete(root)
        poll()
      })
      this.watchers.set(root, watcher)
    } catch {
      poll()
    }
  }

  create(repo: string, input: Partial<Ticket>): Ticket {
    const directory = this.ensure(repo)
    const title = clean(input.title, 160)
    if (!title) throw new Error('Add a title before creating the ticket.')
    const status = input.status ?? 'backlog'
    const priority = input.priority ?? 'normal'
    if (!STATUSES.includes(status)) throw new Error('Choose a valid ticket status.')
    if (!PRIORITIES.includes(priority)) throw new Error('Choose a valid priority.')
    const now = new Date().toISOString()
    let id = ''
    let path = ''
    do {
      id = `AH-${randomBytes(4).toString('hex').toUpperCase()}`
      path = join(directory, `${id}.json`)
    } while (existsSync(path))
    const ticket: Ticket = {
      id, title, status, priority,
      description: clean(input.description, 60000),
      acceptance: stringList(input.acceptance),
      agent: clean(input.agent, 120),
      contextId: clean(input.contextId, 120),
      contextName: clean(input.contextName, 120),
      createdAt: now, updatedAt: now,
    }
    this.save(path, ticket)
    this.watchRepo(repo)
    return ticket
  }

  update(repo: string, id: string, patch: Partial<Ticket>, expectedUpdatedAt?: string): Ticket {
    this.ensure(repo)
    const path = this.file(resolve(repo), id)
    const current = this.readFile(path)
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) throw new Error('This ticket changed on disk. Close and reopen it before saving your changes.')
    const status = patch.status ?? current.status
    const priority = patch.priority ?? current.priority
    if (!STATUSES.includes(status)) throw new Error('Choose a valid ticket status.')
    if (!PRIORITIES.includes(priority)) throw new Error('Choose a valid priority.')
    const next: Ticket = {
      ...current,
      title: patch.title === undefined ? current.title : clean(patch.title, 160),
      status, priority,
      description: patch.description === undefined ? current.description : clean(patch.description, 60000),
      acceptance: patch.acceptance === undefined ? current.acceptance : stringList(patch.acceptance),
      agent: patch.agent === undefined ? current.agent : clean(patch.agent, 120),
      contextId: patch.contextId === undefined ? current.contextId : clean(patch.contextId, 120),
      contextName: patch.contextName === undefined ? current.contextName : clean(patch.contextName, 120),
      updatedAt: new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1 || 0)).toISOString(),
    }
    if (!next.title) throw new Error('A ticket title cannot be blank.')
    this.save(path, next)
    this.watchRepo(repo)
    return next
  }

  close() {
    for (const watcher of this.watchers.values()) watcher.close()
    for (const timer of this.timers.values()) clearTimeout(timer)
    for (const timer of this.pollers.values()) clearInterval(timer)
    this.watchers.clear(); this.timers.clear(); this.pollers.clear(); this.snapshots.clear()
  }

  private save(path: string, ticket: Ticket) {
    const temporary = `${path}.${process.pid}.${uuid()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(ticket, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, path)
    } finally { rmSync(temporary, { force: true }) }
  }
}
