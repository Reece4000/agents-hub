import { createHash, randomBytes, randomUUID as cryptoRandomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import type { BoardCommand, BoardImage, BoardLink, BoardNote, BoardPosition, BoardQuery, BoardSection, BoardSnapshot, Evidence, NoteKind, TaskState } from '../shared/board'
import { withMissingPositions } from '../shared/board-layout'

const idPattern = /^(?:AH-[A-F0-9]{8}|[A-Z]{2}-[A-F0-9]{12})$/
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const now = () => new Date().toISOString()
const text = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const list = (value: unknown, max = 40) => Array.isArray(value) ? value.filter(v => typeof v === 'string').slice(0, max).map(v => text(v, 500)).filter(Boolean) : []
const validPosition = (value: unknown): value is BoardPosition => !!value && typeof value === 'object' && Number.isFinite((value as BoardPosition).x) && Number.isFinite((value as BoardPosition).y) && Math.abs((value as BoardPosition).x) < 1_000_000 && Math.abs((value as BoardPosition).y) < 1_000_000
const kinds: NoteKind[] = ['task', 'context', 'note']
const states: TaskState[] = ['open', 'working', 'blocked', 'done']
const linkKinds = ['relates_to', 'depends_on', 'learned_from']
const newId = (prefix: 'AH' | 'SC') => `${prefix}-${randomBytes(6).toString('hex').toUpperCase()}`
const isLink = (value: any): value is BoardLink => value && idPattern.test(value.to) && linkKinds.includes(value.kind)
const evidenceList = (value: unknown): Evidence[] => Array.isArray(value) ? value.slice(0, 30).filter(v => v && typeof v.path === 'string' && v.path.trim()).map(v => ({ path: text(v.path, 500), ...(v.detail ? { detail: text(v.detail, 500) } : {}) })) : []
const imageId = /^[a-f0-9-]{36}$/
const imageTypes: Record<string, { extension: string; valid: (data: Buffer) => boolean }> = {
  'image/png': { extension: 'png', valid: data => data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  'image/jpeg': { extension: 'jpg', valid: data => data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff },
  'image/webp': { extension: 'webp', valid: data => data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' },
  'image/gif': { extension: 'gif', valid: data => ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6)) },
}
const imagesList = (value: unknown): BoardImage[] => Array.isArray(value) ? value.slice(0, 20).filter((item: any) => item && imageId.test(item.id) && typeof item.path === 'string' && new RegExp(`^\\.agents-hub/assets/${item.id}\\.(?:png|jpg|webp|gif)$`).test(item.path) && typeof item.name === 'string' && imageTypes[item.mime] && Number.isFinite(item.size)).map((item: any) => ({ id: item.id, path: item.path, name: text(item.name, 180), mime: item.mime, size: item.size, ...(item.description ? { description: text(item.description, 500) } : {}) })) : []

interface Layout { version: 1; sections: BoardSection[]; positions: Record<string, BoardPosition> }
interface CompletionJournal { command: Extract<BoardCommand, { type: 'completeTask' }>; changes: Array<Extract<BoardCommand, { type: 'completeTask' }>['contextChanges'][number] & { id: string }>; completed: string[] }

/** Repo files are the authority. The renderer and agents use this same module
 * for parsing, optimistic writes, migration, search, and completion. */
/** `passive` stores serve short-lived agent processes (the board CLI and
 *  MCP server): they never rewrite repo instruction files or start watchers.
 *  The desktop app's active store owns both. */
/** Generated agent guide at `.agents-hub/README.md`. Earlier generated
 *  versions (by content hash) are upgraded in place; a guide someone edited
 *  is left alone. */
const BOARD_GUIDE = "# Agent Hub board\n\nThe Tasks canvas is shared repo memory. Read `.agents-hub/notes/*.md` for tasks, notes, and codebase context. Each note has JSON metadata between `---` lines and a Markdown body. `.agents-hub/canvas.json` holds only spatial layout.\n\nIn an Agent Hub terminal the board is available two ways:\n\n- MCP tools named `board_*` (Claude Code and Codex terminals are configured automatically).\n- The `agent-hub-board` command: `agent-hub-board summary`, then `search`, `read`, or `related` with one JSON argument, e.g. `agent-hub-board search '{\"kind\":\"context\",\"text\":\"database\"}'`.\n\nStart with `board_summary`. Its `activeTask` is the Task your Session is working on; read it, search for related Context notes, and keep its status current. Mutations take the `expectedRevision` from a fresh read; read again if another writer changed a note.\n\nOn completion, record the outcome and checked acceptance criteria with `board_complete_task` (`agent-hub-board complete-task`), capturing one concise, evidence-backed codebase fact in a Context note. Give a no-learning reason only when nothing durable was learned. Without the board tools, read these Markdown files directly and leave edits to an Agent Hub terminal.\n\nOld `.agents-hub/tickets/*.json` files are preserved as migration sources. Edit the new note files for current Tasks.\n"
const LEGACY_GUIDES = new Set(['d418fcfb1107feab0dc9f50f86a26a19b0d7a919a96b3c699bcc5bc92f6c13a8'])

export interface BoardStoreOptions { passive?: boolean }

export class BoardStore extends EventEmitter {
  constructor(private options: BoardStoreOptions = {}) { super() }
  private watchers = new Map<string, FSWatcher[]>()
  private pollers = new Map<string, NodeJS.Timeout>()
  private signatures = new Map<string, string>()
  private diskSignatures = new Map<string, string>()
  private snapshots = new Map<string, BoardSnapshot>()
  private heldLocks = new Set<string>()

  private paths(repo: string) {
    const root = resolve(repo), hub = join(root, '.agents-hub')
    return { root, hub, notes: join(hub, 'notes'), assets: join(hub, 'assets'), layout: join(hub, 'canvas.json'), history: join(hub, 'history'), trash: join(hub, 'trash'), ops: join(hub, 'operations'), tickets: join(hub, 'tickets'), manifest: join(hub, 'migration.json') }
  }
  private ensure(repo: string, create = true) {
    const paths = this.paths(repo)
    const realRoot = realpathSync(paths.root)
    for (const path of [paths.hub, paths.notes, paths.assets, paths.history, paths.trash, paths.ops, paths.tickets, paths.layout, paths.manifest]) {
      if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Board path must not be a symlink: ${path}`)
    }
    if (create) for (const path of [paths.hub, paths.notes, paths.assets, paths.history, paths.trash, paths.ops]) mkdirSync(path, { recursive: true, mode: 0o700 })
    for (const path of [paths.hub, paths.notes, paths.assets, paths.history, paths.trash, paths.ops]) {
      if (!existsSync(path)) continue
      const actual = realpathSync(path)
      if (actual !== realRoot && !actual.startsWith(`${realRoot}${sep}`)) throw new Error('Board files must stay inside the selected workspace.')
    }
    if (create) {
      const guide = join(paths.hub, 'README.md')
      if (lstatSync(guide, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Board guide must not be a symlink.')
      const existing = lstatSync(guide, { throwIfNoEntry: false }) ? readFileSync(guide, 'utf8') : null
      if (existing === null || LEGACY_GUIDES.has(hash(existing))) { if (existing !== BOARD_GUIDE) this.atomic(guide, BOARD_GUIDE) }
    }
    return paths
  }
  private notePath(repo: string, id: string) {
    if (!idPattern.test(id)) throw new Error('Invalid note ID.')
    return join(this.paths(repo).notes, `${id}.md`)
  }
  saveImage(repo: string, name: unknown, mime: unknown, base64: unknown): BoardImage {
    const paths = this.ensure(repo)
    const type = typeof mime === 'string' ? imageTypes[mime] : undefined
    if (!type || typeof base64 !== 'string' || base64.length > 28_000_000) throw new Error('Choose a PNG, JPEG, WebP, or GIF image under 20 MB.')
    const data = Buffer.from(base64, 'base64')
    if (!data.length || data.length > 20 * 1024 * 1024 || !type.valid(data)) throw new Error('This image is empty, too large, or does not match its file type.')
    const id = cryptoRandomUUID()
    const filename = `${id}.${type.extension}`
    const path = join(paths.assets, filename)
    if (lstatSync(path, { throwIfNoEntry: false })) throw new Error('Image ID collision.')
    writeFileSync(path, data, { flag: 'wx', mode: 0o600 })
    return { id, path: `.agents-hub/assets/${filename}`, name: text(basename(String(name || 'image')), 180), mime: mime as string, size: data.length }
  }
  imagePreview(repo: string, id: unknown): string {
    const paths = this.ensure(repo, false)
    if (typeof id !== 'string' || !imageId.test(id)) throw new Error('Invalid image ID.')
    const filename = readdirSync(paths.assets).find(name => name.startsWith(`${id}.`) && /\.(?:png|jpg|webp|gif)$/.test(name))
    if (!filename) throw new Error('Image file is missing.')
    const path = join(paths.assets, filename)
    if (lstatSync(path).isSymbolicLink()) throw new Error('Image file must not be a symlink.')
    const mime = filename.endsWith('.png') ? 'image/png' : filename.endsWith('.jpg') ? 'image/jpeg' : filename.endsWith('.webp') ? 'image/webp' : 'image/gif'
    return `data:${mime};base64,${readFileSync(path).toString('base64')}`
  }
  private atomic(path: string, contents: string, mode = 0o600) {
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      writeFileSync(temporary, contents, { mode, flag: 'wx' })
      renameSync(temporary, path)
    } finally { rmSync(temporary, { force: true }) }
  }
  private ensureAgentInstructions(repo: string): string[] {
    const errors: string[] = []
    const begin = '<!-- agent-hub:begin -->', end = '<!-- agent-hub:end -->'
    const block = `${begin}\nThis repository uses the Agent Hub Tasks canvas as shared working context: tasks, notes, and evidence-backed codebase facts in \`.agents-hub/notes/\`. Read \`.agents-hub/README.md\` before working. In an Agent Hub terminal, use the \`board_*\` MCP tools or the \`agent-hub-board\` command (\`agent-hub-board summary\`, then \`search\`, \`read\`, or \`related\`). The summary's \`activeTask\` is the Task your Session is working on: keep its status current and finish it with \`board_complete_task\`, capturing one concise, evidence-backed codebase learning. For an agent without the board tools, read the Markdown notes directly and follow the board guide.\n${end}`
    const files = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']
    if (existsSync(join(repo, 'AGENTS.override.md'))) files.push('AGENTS.override.md')
    for (const name of files) {
      const path = join(repo, name)
      try {
        const stat = lstatSync(path, { throwIfNoEntry: false })
        if (stat?.isSymbolicLink()) throw new Error('is a symlink')
        if (stat && !stat.isFile()) throw new Error('is not a regular file')
        const existing = stat ? readFileSync(path, 'utf8') : ''
        const start = existing.indexOf(begin), finish = existing.indexOf(end)
        if ((start >= 0) !== (finish >= 0) || (start >= 0 && finish < start)) throw new Error('has an incomplete Agent Hub instruction block')
        const next = start >= 0 ? `${existing.slice(0, start)}${block}${existing.slice(finish + end.length)}` : `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${existing ? '\n' : ''}${block}\n`
        if (next !== existing) this.atomic(path, next, stat ? stat.mode & 0o777 : 0o644)
      } catch (error) { errors.push(`${name}: ${(error as Error).message}`) }
    }
    return errors
  }
  private lock(repo: string) {
    const path = join(this.paths(repo).hub, '.write-lock')
    const start = Date.now(), wait = new Int32Array(new SharedArrayBuffer(4))
    for (;;) {
      try { mkdirSync(path, { mode: 0o700 }); this.heldLocks.add(repo); return () => { this.heldLocks.delete(repo); rmSync(path, { recursive: true, force: true }) } }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (lstatSync(path).isSymbolicLink()) throw new Error('Board lock must not be a symlink.')
        if (Date.now() - statSync(path).mtimeMs > 30_000) { rmSync(path, { recursive: true, force: true }); continue }
        if (Date.now() - start > 2_000) throw new Error('Another board writer is busy. Retry in a moment.')
        Atomics.wait(wait, 0, 0, 15)
      }
    }
  }
  private encode(note: BoardNote) {
    const { body, revision, ...metadata } = note
    return `---\n${JSON.stringify({ version: 1, ...metadata, presentationHash: hash(`${note.title}\0${body.trimEnd()}`) }, null, 2)}\n---\n${body.trimEnd()}\n`
  }
  private decode(file: string, strictName = true): BoardNote {
    if (lstatSync(file).isSymbolicLink()) throw new Error(`${basename(file)} must not be a symlink.`)
    const raw = readFileSync(file, 'utf8')
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
    if (!match) throw new Error(`${basename(file)} needs JSON frontmatter between --- lines.`)
    const value = JSON.parse(match[1]) as Record<string, any>
    if (value.version !== 1 || !idPattern.test(value.id) || (strictName && basename(file) !== `${value.id}.md`) || !kinds.includes(value.kind) || !text(value.title, 160)) throw new Error(`${basename(file)} has invalid note metadata.`)
    const note: BoardNote = {
      id: value.id, kind: value.kind, title: text(value.title, 160), body: match[2].trimEnd(),
      createdAt: text(value.createdAt, 40) || now(), updatedAt: text(value.updatedAt, 40) || now(), updatedBy: text(value.updatedBy, 100) || 'external',
      revision: hash(raw), sectionId: text(value.sectionId, 100), links: Array.isArray(value.links) ? value.links.filter(isLink).slice(0, 80) : [], images: imagesList(value.images),
      userSource: value.userSource && typeof value.userSource.title === 'string' && typeof value.userSource.body === 'string' ? { title: text(value.userSource.title, 160), body: text(value.userSource.body, 60000) } : { title: text(value.title, 160), body: match[2].trimEnd() },
    }
    if (typeof value.presentationHash === 'string' && value.presentationHash !== hash(`${note.title}\0${note.body}`)) {
      note.userSource = { title: note.title, body: note.body }
      note.updatedBy = 'external'
    }
    if (note.kind === 'task') {
      note.status = states.includes(value.status) ? value.status : 'open'
      note.acceptance = list(value.acceptance)
      note.sessionId = text(value.sessionId, 120)
      note.agent = text(value.agent, 120)
      note.outcome = text(value.outcome, 60000)
      note.captureState = ['pending', 'captured', 'none', 'legacy_unknown'].includes(value.captureState) ? value.captureState : 'pending'
      note.noLearningReason = text(value.noLearningReason, 2000)
      if (value.legacyStatus) note.legacyStatus = text(value.legacyStatus, 40)
    } else if (note.kind === 'context') {
      note.subject = text(value.subject, 200)
      note.evidence = evidenceList(value.evidence)
      note.sourceTaskIds = list(value.sourceTaskIds)
      note.verifiedAt = text(value.verifiedAt, 40)
    }
    return note
  }
  private readNote(repo: string, id: string) {
    const path = this.notePath(repo, id)
    if (!existsSync(path)) throw new Error(`Note ${id} no longer exists.`)
    return this.decode(path)
  }
  private saveNote(repo: string, note: BoardNote, expectedRevision?: string) {
    const path = this.notePath(repo, note.id)
    const old = existsSync(path) ? this.decode(path) : undefined
    if (expectedRevision !== undefined && old?.revision !== expectedRevision) throw new Error(`Note ${note.id} changed on disk. Reload it before saving.`)
    if (old) {
      const history = join(this.paths(repo).history, note.id)
      if (lstatSync(history, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Note history must not be a symlink.')
      mkdirSync(history, { recursive: true, mode: 0o700 })
      const realHub = realpathSync(this.paths(repo).hub), realHistory = realpathSync(history)
      if (!realHistory.startsWith(`${realHub}${sep}`)) throw new Error('Note history must stay inside the repository.')
      const copy = join(history, `${old.revision}.md`)
      if (!existsSync(copy)) this.atomic(copy, readFileSync(path, 'utf8'))
    }
    this.atomic(path, this.encode(note))
    return this.decode(path)
  }
  private readLayout(repo: string): Layout {
    const path = this.paths(repo).layout
    if (!existsSync(path)) return { version: 1, sections: [], positions: {} }
    if (lstatSync(path).isSymbolicLink()) throw new Error('Canvas file must not be a symlink.')
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Layout
    if (raw.version !== 1 || !Array.isArray(raw.sections) || !raw.positions || typeof raw.positions !== 'object') throw new Error('Canvas layout has an unsupported format.')
    return { version: 1, sections: raw.sections.filter(section => section && typeof section.id === 'string' && typeof section.title === 'string' && validPosition(section) && Number.isFinite(section.width) && Number.isFinite(section.height)), positions: Object.fromEntries(Object.entries(raw.positions).filter(([, p]) => validPosition(p))) }
  }
  private saveLayout(repo: string, layout: Layout) { this.atomic(this.paths(repo).layout, `${JSON.stringify(layout, null, 2)}\n`) }
  private migrate(repo: string): string[] {
    const p = this.paths(repo)
    if (!existsSync(p.tickets)) return []
    const files = readdirSync(p.tickets).filter(name => /^AH-[A-F0-9]{8}\.json$/.test(name))
    if (!files.length) return []
    const manifest: { version: 1; sources: Record<string, string> } = existsSync(p.manifest) ? JSON.parse(readFileSync(p.manifest, 'utf8')) : { version: 1, sources: {} }
    if (manifest.version !== 1 || !manifest.sources || typeof manifest.sources !== 'object') throw new Error('Migration manifest has an unsupported format.')
    const layout = this.readLayout(repo)
    const errors: string[] = []
    let changed = false
    for (const name of files) {
      const source = join(p.tickets, name)
      if (lstatSync(source).isSymbolicLink()) { errors.push(`Legacy ticket ${name} is a symlink and was skipped.`); continue }
      const raw = readFileSync(source, 'utf8'), sourceHash = hash(raw), id = name.slice(0, -5)
      if (manifest.sources[id]) continue
      const destination = this.notePath(repo, id)
      if (existsSync(destination)) {
        try {
          const existing = this.decode(destination)
          if (existing.updatedBy === 'migration' && existing.kind === 'task') { manifest.sources[id] = sourceHash; changed = true }
          else errors.push(`Legacy ticket ${id} collides with an existing Task note. Compare both files before importing.`)
        } catch { errors.push(`Legacy ticket ${id} has a malformed destination note. Repair it before importing.`) }
        continue
      }
      let ticket: any
      try { ticket = JSON.parse(raw) } catch { errors.push(`Legacy ticket ${name} is malformed and was skipped.`); continue }
      const status: TaskState = ticket.status === 'blocked' ? 'blocked' : ticket.status === 'completed' ? 'done' : ['in_progress', 'needs_testing'].includes(ticket.status) ? 'working' : 'open'
      const note: BoardNote = {
        id, kind: 'task', title: text(ticket.title, 160) || 'Untitled task', body: text(ticket.description, 60000),
        createdAt: text(ticket.createdAt, 40) || now(), updatedAt: text(ticket.updatedAt, 40) || now(), updatedBy: 'migration', revision: '', sectionId: '', links: [],
        status, acceptance: list(ticket.acceptance), sessionId: text(ticket.contextId, 120), agent: text(ticket.agent, 120), outcome: '',
        captureState: status === 'done' ? 'legacy_unknown' : 'pending', legacyStatus: text(ticket.status, 40),
      }
      this.saveNote(repo, note)
      const count = Object.keys(layout.positions).length
      layout.positions[id] = { x: 90 + (count % 3) * 314, y: 110 + Math.floor(count / 3) * 220 }
      manifest.sources[id] = sourceHash
      changed = true
    }
    if (changed) { this.saveLayout(repo, layout); this.atomic(p.manifest, `${JSON.stringify(manifest, null, 2)}\n`) }
    return errors
  }
  private snapshot(repo: string): BoardSnapshot {
    const p = this.ensure(repo, false)
    const errors: string[] = []
    let readOnly = false
    try { accessSync(existsSync(p.hub) ? p.hub : p.root, constants.W_OK); this.ensure(repo) }
    catch (error) { readOnly = true; errors.push(`Board is read-only: ${(error as Error).message}`) }
    if (!readOnly && !this.options.passive) errors.push(...this.ensureAgentInstructions(p.root).map(error => `Agent instructions: ${error}`))
    if (!readOnly) try {
      const unlock = this.heldLocks.has(repo) ? null : this.lock(repo)
      try { errors.push(...this.migrate(repo)) } finally { unlock?.() }
    } catch (error) { errors.push(`Migration needs attention: ${(error as Error).message}`) }
    const notes: BoardNote[] = []
    for (const name of (existsSync(p.notes) ? readdirSync(p.notes) : []).filter(name => /^[A-Z]{2}-[A-F0-9]{8,12}\.md$/.test(name))) {
      try { notes.push(this.decode(join(p.notes, name))) } catch (error) { errors.push(`${name}: ${(error as Error).message}`) }
    }
    let layout: Layout
    try { layout = this.readLayout(repo) } catch (error) { errors.push((error as Error).message); layout = { version: 1, sections: [], positions: {} } }
    if (existsSync(p.manifest)) {
      try {
        const manifest = JSON.parse(readFileSync(p.manifest, 'utf8')) as { sources: Record<string, string> }
        for (const [id, original] of Object.entries(manifest.sources ?? {})) {
          const path = join(p.tickets, `${id}.json`)
          if (existsSync(path) && hash(readFileSync(path, 'utf8')) !== original) errors.push(`Legacy ticket ${id} changed after migration. Compare it with its Task note.`)
        }
      } catch (error) { errors.push(`Migration manifest: ${(error as Error).message}`) }
    }
    for (const name of (existsSync(p.ops) ? readdirSync(p.ops) : []).filter(name => name.endsWith('.json'))) {
      try {
        const journalPath = join(p.ops, name)
        if (lstatSync(journalPath).isSymbolicLink()) throw new Error('Journal must not be a symlink.')
        const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as CompletionJournal
        const task = notes.find(note => note.id === journal.command.id)
        if (task?.status !== 'done') errors.push(`Task ${journal.command.id} has an interrupted knowledge capture. Retry completion with operation ${name.slice(0, -5)}.`)
      } catch { errors.push(`Completion operation ${name} needs repair.`) }
    }
    if (!readOnly) try { for (const directory of [p.hub, p.notes, p.history, p.trash, p.ops]) accessSync(directory, constants.W_OK) } catch { readOnly = true; errors.push('Board files are read-only.') }
    notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const positions = withMissingPositions(notes, layout.positions)
    if (!readOnly && notes.some(note => !layout.positions[note.id])) {
      try { this.saveLayout(repo, { ...layout, positions }) }
      catch (error) { errors.push(`Could not save canvas positions: ${(error as Error).message}`) }
    }
    const snapshot = { repo: p.root, notes, sections: layout.sections, positions, errors, readOnly }
    this.snapshots.set(p.root, snapshot)
    return snapshot
  }
  load(repo: string): BoardSnapshot {
    const root = resolve(repo)
    const snapshot = this.snapshot(root)
    if (!this.options.passive) this.watch(root)
    return snapshot
  }
  private publish(repo: string) {
    const disk = this.diskSignature(repo)
    const cached = this.snapshots.get(repo)
    if (cached && this.diskSignatures.get(repo) === disk) return cached
    const current = this.snapshot(repo)
    this.diskSignatures.set(repo, this.diskSignature(repo))
    const signature = hash(JSON.stringify(current))
    if (signature !== this.signatures.get(repo)) {
      this.signatures.set(repo, signature)
      this.emit('change', current)
    }
    return current
  }
  private diskSignature(repo: string) {
    const p = this.paths(repo)
    const files = [p.notes, p.tickets, p.ops].flatMap(directory => existsSync(directory) ? readdirSync(directory).sort().map(name => join(directory, name)) : [])
    return [p.layout, p.manifest, ...files].map(path => {
      try { const stat = lstatSync(path); return `${path}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` }
      catch { return `${path}:missing` }
    }).join('|')
  }
  private watch(repo: string) {
    if (this.pollers.has(repo)) return
    this.signatures.set(repo, hash(JSON.stringify(this.snapshots.get(repo))))
    this.diskSignatures.set(repo, this.diskSignature(repo))
    const p = this.paths(repo)
    const watchers: FSWatcher[] = []
    const update = () => { try { this.publish(repo) } catch (error) { this.emit('change', { ...this.snapshots.get(repo), errors: [(error as Error).message] }) } }
    for (const path of [p.notes, p.hub, p.tickets]) {
      if (!existsSync(path)) continue
      try {
        const watcher = watch(path, () => update())
        watcher.on('error', () => { watcher.close(); update() })
        watchers.push(watcher)
      } catch { /* polling below covers unavailable watchers */ }
    }
    this.watchers.set(repo, watchers)
    const timer = setInterval(update, 1000)
    timer.unref()
    this.pollers.set(repo, timer)
  }
  query(repo: string, query: BoardQuery): unknown {
    const snapshot = this.load(repo)
    const notes = snapshot.notes
    if (query.type === 'read') return notes.find(note => note.id === query.id) ?? null
    if (query.type === 'summary') return { total: notes.length, byKind: Object.fromEntries(kinds.map(kind => [kind, notes.filter(note => note.kind === kind).length])), byStatus: Object.fromEntries(states.map(status => [status, notes.filter(note => note.status === status).length])), sections: snapshot.sections.map(({ id, title }) => ({ id, title })), recent: [...notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12).map(({ id, kind, title, updatedAt }) => ({ id, kind, title, updatedAt })), errors: snapshot.errors }
    if (query.type === 'related') {
      const source = notes.find(note => note.id === query.id)
      if (!source) return []
      return notes.filter(note => source.links.some(link => link.to === note.id) || note.links.some(link => link.to === source.id))
    }
    if (query.type === 'history') {
      if (!idPattern.test(query.id)) throw new Error('Invalid note ID.')
      const path = join(this.paths(repo).history, query.id)
      if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Note history must not be a symlink.')
      return existsSync(path) ? readdirSync(path).filter(name => name.endsWith('.md')).map(name => ({ revision: name.slice(0, -3), note: this.decode(join(path, name), false) })) : []
    }
    if (query.type === 'trash') {
      const directory = this.paths(repo).trash
      return existsSync(directory) ? readdirSync(directory).filter(name => /^[A-Z]{2}-[A-F0-9]{8,12}\.md$/.test(name)).map(name => this.decode(join(directory, name))) : []
    }
    const term = (query.text ?? '').toLocaleLowerCase().trim()
    return notes.filter(note => (!query.kind || note.kind === query.kind) && (!query.status || note.status === query.status) && (!query.sectionId || note.sectionId === query.sectionId) && (!query.path || note.evidence?.some(item => item.path.includes(query.path!))) && (!query.linkedTo || note.links.some(link => link.to === query.linkedTo) || notes.find(other => other.id === query.linkedTo)?.links.some(link => link.to === note.id)) && (!term || `${note.title}\n${note.body}\n${note.subject ?? ''}\n${note.outcome ?? ''}\n${(note.acceptance ?? []).join('\n')}\n${(note.evidence ?? []).map(item => item.path).join('\n')}`.toLocaleLowerCase().includes(term))).slice(0, Math.max(1, Math.min(200, query.limit ?? 50)))
  }
  apply(repo: string, command: BoardCommand): unknown {
    const root = resolve(repo), p = this.ensure(root)
    const unlock = this.lock(root)
    try {
    this.migrate(root)
    let result: unknown
    if (command.type === 'createNote') {
      if (!kinds.includes(command.note.kind)) throw new Error('Choose a note type.')
      const id = command.note.id && idPattern.test(command.note.id) ? command.note.id : newId('AH')
      if (existsSync(this.notePath(root, id))) throw new Error(`Note ${id} already exists.`)
      const title = text(command.note.title, 160)
      if (!title) throw new Error('Add a title to the note.')
      const stamp = now()
      const note: BoardNote = { id, kind: command.note.kind, title, body: text(command.note.body, 60000), createdAt: stamp, updatedAt: stamp, updatedBy: text(command.note.updatedBy, 100) || 'person', revision: '', sectionId: text(command.note.sectionId, 100), links: Array.isArray(command.note.links) ? command.note.links.filter(isLink).slice(0, 80) : [], images: imagesList(command.note.images), userSource: { title, body: text(command.note.body, 60000) }, ...(command.note.kind === 'task' ? { status: command.note.status && states.includes(command.note.status) ? command.note.status : 'open' as const, acceptance: list(command.note.acceptance), sessionId: text(command.note.sessionId, 120), agent: text(command.note.agent, 120), captureState: 'pending' as const } : {}), ...(command.note.kind === 'context' ? { subject: text(command.note.subject, 200) || title, evidence: evidenceList(command.note.evidence), sourceTaskIds: list(command.note.sourceTaskIds), verifiedAt: text(command.note.verifiedAt, 40) } : {}) }
      result = this.saveNote(root, note)
      const layout = this.readLayout(root)
      layout.positions[id] = validPosition(command.position) ? command.position : { x: 120 + (Object.keys(layout.positions).length % 3) * 315, y: 120 + Math.floor(Object.keys(layout.positions).length / 3) * 220 }
      this.saveLayout(root, layout)
    } else if (command.type === 'updateNote') {
      const current = this.readNote(root, command.id)
      if (current.revision !== command.expectedRevision) throw new Error('This note changed on disk. Reload before saving.')
      const patch = command.patch
      if (patch.sectionId && !this.readLayout(root).sections.some(section => section.id === patch.sectionId)) throw new Error('Section no longer exists.')
      const kind = patch.kind && kinds.includes(patch.kind) ? patch.kind : current.kind
      const next: BoardNote = { ...current, kind, title: patch.title === undefined ? current.title : text(patch.title, 160), body: patch.body === undefined ? current.body : text(patch.body, 60000), sectionId: patch.sectionId === undefined ? current.sectionId : text(patch.sectionId, 100), links: patch.links === undefined ? current.links : patch.links.filter(isLink).slice(0, 80), images: patch.images === undefined ? current.images : imagesList(patch.images), updatedAt: now(), updatedBy: text(patch.updatedBy, 100) || 'person' }
      if (!next.title) throw new Error('A note needs a title.')
      if (next.updatedBy === 'person' && (next.title !== current.title || next.body !== current.body)) next.userSource = { title: next.title, body: next.body }
      if (kind === 'task') {
        if (patch.status === 'done' && current.status !== 'done') throw new Error('Complete the task with an outcome and codebase learning.')
        next.status = patch.status && states.includes(patch.status) ? patch.status : current.status ?? 'open'
        next.acceptance = patch.acceptance === undefined ? current.acceptance ?? [] : list(patch.acceptance)
        next.sessionId = patch.sessionId === undefined ? current.sessionId ?? '' : text(patch.sessionId, 120)
        next.agent = patch.agent === undefined ? current.agent ?? '' : text(patch.agent, 120)
        next.outcome = patch.outcome === undefined ? current.outcome ?? '' : text(patch.outcome, 60000)
        next.captureState = next.status === 'done' && current.status !== 'done' ? 'pending' : current.captureState ?? 'pending'
      } else if (kind === 'context') {
        next.subject = patch.subject === undefined ? current.subject ?? next.title : text(patch.subject, 200)
        next.evidence = patch.evidence === undefined ? current.evidence ?? [] : evidenceList(patch.evidence)
        next.sourceTaskIds = patch.sourceTaskIds === undefined ? current.sourceTaskIds ?? [] : list(patch.sourceTaskIds)
        next.verifiedAt = patch.verifiedAt === undefined ? current.verifiedAt ?? '' : text(patch.verifiedAt, 40)
      }
      result = this.saveNote(root, next, command.expectedRevision)
    } else if (command.type === 'moveNote') {
      if (!validPosition(command.position)) throw new Error('Invalid position.')
      const note = this.readNote(root, command.id)
      if (command.sectionId !== undefined && command.sectionId !== note.sectionId) {
        if (command.sectionId && !this.readLayout(root).sections.some(section => section.id === command.sectionId)) throw new Error('Section no longer exists.')
        if (command.expectedRevision && note.revision !== command.expectedRevision) throw new Error('Note changed while moving. Reload it.')
        this.saveNote(root, { ...note, sectionId: command.sectionId, updatedAt: now(), updatedBy: 'person' }, note.revision)
      }
      const layout = this.readLayout(root)
      layout.positions[note.id] = command.position
      this.saveLayout(root, layout)
      result = this.readNote(root, note.id)
    } else if (command.type === 'createSection') {
      if (!validPosition(command.position)) throw new Error('Invalid section position.')
      const title = text(command.title, 120)
      if (!title) throw new Error('Name the section.')
      const layout = this.readLayout(root)
      const section: BoardSection = { id: newId('SC'), title, x: command.position.x, y: command.position.y, width: 620, height: 410, collapsed: false }
      layout.sections.push(section)
      this.saveLayout(root, layout)
      result = section
    } else if (command.type === 'updateSection') {
      const layout = this.readLayout(root)
      const section = layout.sections.find(item => item.id === command.id)
      if (!section) throw new Error('Section no longer exists.')
      const oldX = section.x, oldY = section.y
      if (command.patch.title !== undefined) section.title = text(command.patch.title, 120) || section.title
      for (const key of ['x', 'y', 'width', 'height'] as const) if (Number.isFinite(command.patch[key])) section[key] = Number(command.patch[key])
      section.width = Math.max(340, Math.min(4000, section.width)); section.height = Math.max(180, Math.min(4000, section.height))
      if (command.patch.collapsed !== undefined) section.collapsed = !!command.patch.collapsed
      const dx = section.x - oldX, dy = section.y - oldY
      if (dx || dy) for (const note of this.snapshot(root).notes.filter(note => note.sectionId === section.id)) {
        const position = layout.positions[note.id]
        if (position) layout.positions[note.id] = { x: position.x + dx, y: position.y + dy }
      }
      this.saveLayout(root, layout)
      result = section
    } else if (command.type === 'deleteSection') {
      const layout = this.readLayout(root)
      if (!layout.sections.some(item => item.id === command.id)) throw new Error('Section no longer exists.')
      const members = this.snapshot(root).notes.filter(note => note.sectionId === command.id)
      for (const note of members) {
        if (command.keepNotes) this.saveNote(root, { ...note, sectionId: '', updatedAt: now(), updatedBy: 'person' }, note.revision)
        else this.trash(root, note.id, note.revision)
      }
      layout.sections = layout.sections.filter(item => item.id !== command.id)
      this.saveLayout(root, layout)
      result = null
    } else if (command.type === 'trashNote') result = this.trash(root, command.id, command.expectedRevision)
    else if (command.type === 'restoreNote') {
      if (!idPattern.test(command.id)) throw new Error('Invalid note ID.')
      const source = join(p.trash, `${command.id}.md`), target = this.notePath(root, command.id)
      if (!existsSync(source) || existsSync(target)) throw new Error('This note cannot be restored.')
      renameSync(source, target)
      result = this.readNote(root, command.id)
    } else if (command.type === 'completeTask') result = this.complete(root, command)
    this.publish(root)
    return result
    } finally { unlock() }
  }
  private trash(repo: string, id: string, expectedRevision: string) {
    const current = this.readNote(repo, id)
    if (current.revision !== expectedRevision) throw new Error('This note changed on disk. Reload before deleting.')
    const source = this.notePath(repo, id), target = join(this.paths(repo).trash, `${id}.md`)
    if (existsSync(target)) rmSync(target)
    renameSync(source, target)
    const layout = this.readLayout(repo)
    delete layout.positions[id]
    this.saveLayout(repo, layout)
    return current
  }
  private complete(repo: string, command: Extract<BoardCommand, { type: 'completeTask' }>) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(command.operationId)) throw new Error('Invalid completion operation ID.')
    if (!text(command.outcome, 60000)) throw new Error('Describe what the task delivered.')
    if (!command.contextChanges.length && !text(command.noLearningReason, 2000)) throw new Error('Add a codebase learning or explain why there is none.')
    const path = join(this.paths(repo).ops, `${command.operationId}.json`)
    let journal: CompletionJournal
    if (existsSync(path)) {
      if (lstatSync(path).isSymbolicLink()) throw new Error('Completion journal must not be a symlink.')
      journal = JSON.parse(readFileSync(path, 'utf8')) as CompletionJournal
    }
    else {
      const task = this.readNote(repo, command.id)
      if (task.kind !== 'task' || task.revision !== command.expectedRevision) throw new Error('Task changed on disk. Reload before completing.')
      const notes = this.snapshot(repo).notes
      const changes = command.contextChanges.map(change => {
        if (change.id && !change.expectedRevision) throw new Error('Updating a context note requires its current revision.')
        const matching = notes.find(note => note.kind === 'context' && (note.id === change.id || (!change.id && note.subject?.toLocaleLowerCase() === change.subject.trim().toLocaleLowerCase())))
        return { ...change, id: change.id || matching?.id || newId('AH'), expectedRevision: change.expectedRevision || matching?.revision }
      })
      journal = { command, changes, completed: [] }
      this.atomic(path, `${JSON.stringify(journal, null, 2)}\n`)
    }
    if (journal.command.id !== command.id) throw new Error('Completion operation belongs to a different task.')
    for (const change of journal.changes) {
      if (journal.completed.includes(change.id)) continue
      if (!text(change.title, 160) || !text(change.subject, 200) || !text(change.body, 60000) || !evidenceList(change.evidence).length) throw new Error('Codebase context needs a title, subject, concise fact, and evidence.')
      const current = existsSync(this.notePath(repo, change.id)) ? this.readNote(repo, change.id) : undefined
      if (current && current.kind !== 'context') throw new Error('Learning target is not a context note.')
      if (current && change.expectedRevision && current.revision !== change.expectedRevision && (current.body !== change.body.trim() || current.subject !== change.subject.trim())) throw new Error('Context note changed on disk. Review it before completing.')
      const stamp = now()
      const next: BoardNote = {
        id: change.id, kind: 'context', title: text(change.title, 160), body: text(change.body, 60000),
        createdAt: current?.createdAt ?? stamp, updatedAt: stamp, updatedBy: text(command.actor, 100) || 'agent', revision: '',
        sectionId: current?.sectionId ?? '', links: [...(current?.links ?? []).filter(link => !(link.to === command.id && link.kind === 'learned_from')), { to: command.id, kind: 'learned_from' }],
        subject: text(change.subject, 200), evidence: evidenceList(change.evidence), sourceTaskIds: [...new Set([...(current?.sourceTaskIds ?? []), command.id])], verifiedAt: stamp,
      }
      if (!current || current.body !== next.body || current.subject !== next.subject || JSON.stringify(current.evidence) !== JSON.stringify(next.evidence) || !current.sourceTaskIds?.includes(command.id)) this.saveNote(repo, next, current?.revision)
      journal.completed.push(change.id)
      this.atomic(path, `${JSON.stringify(journal, null, 2)}\n`)
    }
    const task = this.readNote(repo, command.id)
    if (task.status === 'done' && task.outcome === command.outcome && task.captureState !== 'pending') return task
    if (task.revision !== journal.command.expectedRevision) throw new Error('Task changed during completion. Review its current version.')
    const finished = this.saveNote(repo, { ...task, status: 'done', outcome: text(command.outcome, 60000), acceptance: list(command.acceptance), captureState: journal.changes.length ? 'captured' : 'none', noLearningReason: text(command.noLearningReason, 2000), updatedAt: now(), updatedBy: text(command.actor, 100) || 'agent', links: [...task.links, ...journal.changes.filter(change => !task.links.some(link => link.to === change.id)).map(change => ({ to: change.id, kind: 'relates_to' as const }))] }, task.revision)
    return finished
  }
  close() {
    for (const group of this.watchers.values()) for (const watcher of group) watcher.close()
    for (const timer of this.pollers.values()) clearInterval(timer)
    this.watchers.clear(); this.pollers.clear(); this.signatures.clear(); this.diskSignatures.clear(); this.snapshots.clear()
  }
}
