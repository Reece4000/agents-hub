import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { join, basename, isAbsolute, normalize } from 'node:path'
import { homedir } from 'node:os'
import { v7 as uuid } from 'uuid'
import { Store, newContext, emptyDraft, liveContext, liveResource, liveWorkspace } from './store'
import { MspClient, museExecutable, museEnvironment } from './msp'
import { Terminals } from './terminals'
import { normalizeLaunch } from './launch'
import { availableAgents, customProfile, isBuiltinAgent, nativeProfile } from './provider-profiles'
import { DictationService } from './dictation'
import { BoardOrganizer } from './board-organizer'
import { TicketStore } from './tickets'
import { BoardStore } from './board-store'
import type { BoardCommand, BoardNote, BoardQuery } from '../shared/board'
import type { Attachment, Bootstrap, RepoContext, Skill, Workspace, TerminalKind, TerminalProfile, TerminalResource, Ticket } from '../src/types'
import { normalizeThemeColor, themeEnvironment } from '../src/theme'
import type { ModelListResult } from './generated/msp'
const execute = promisify(execFile)

/** Agent Hub stores repo-local tickets, named terminal contexts, and terminal
 *  resources. Provider-specific controls stay optional; every agent can run as
 *  a normal executable in a supervised PTY. */
export class MuseService extends EventEmitter {
  store: Store
  host: MspClient
  terminals = new Terminals()
  ticketStore = new TicketStore()
  boardStore = new BoardStore()
  dictation = new DictationService()
  organizer = new BoardOrganizer(this.boardStore)
  private draftTimer?: NodeJS.Timeout
  private pendingResources = new Set<string>()
  private opens = new Map<string, Promise<{ data: string; seq: number; cols: number; rows: number; running: boolean }>>()
  private flushTimer?: NodeJS.Timeout
  private skills: Skill[] = []
  private models: Bootstrap['models'] = []
  private connection = 'Local workspace'
  constructor(directory: string, initialRepo = process.cwd(), host = new MspClient(), private boardCliPath = '') {
    super(); this.store = new Store(directory, initialRepo); this.host = host
    this.ticketStore.on('change', snapshot => this.emit('tickets', snapshot))
    this.boardStore.on('change', snapshot => this.emit('board', snapshot))
    host.on('disconnected', () => {
      if (host === this.host) this.connection = 'Disconnected'
      this.changed()
    })
    this.terminals.on('data', event => {
      this.emit('terminal', event)
    })
    this.terminals.on('exit', event => {
      this.emit('terminal', event)
      let owner: RepoContext | undefined
      try {
        const resource = this.store.resource(event.id)
        resource.terminalRunning = false
        owner = this.store.state.contexts.find(c => c.id === resource.contextId)
        if (owner) this.syncContextProjection(owner)
      } catch { return }
      this.changed(event.id)
    })
  }
  private syncContextProjection(context: RepoContext) {
    const first = context.terminals[0]
    if (!first) return
    context.terminalKind = first.terminalKind
    context.launch = first.launch ?? normalizeLaunch({})
    context.draft = first.draft
    context.terminalRunning = !!first.terminalRunning
  }
  private changed(id?: string) {
    if (id) this.pendingResources.add(id)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined; this.store.save()
      for (const id of this.pendingResources) { try { this.emit('resource', liveResource(this.store.resource(id))) } catch { /* deleted resource */ } }
      this.pendingResources.clear()
      this.emit('workspace', liveWorkspace(this.store.state))
    }, 150)
  }
  flush() {
    this.store.state.connection = this.connection
    this.store.save()
    this.emit('workspace', liveWorkspace(this.store.state))
  }
  private async ready() { const info = await this.host.start(); this.connection = `Muse ${info.serverInfo.version}` }
  async bootstrap(): Promise<Bootstrap> {
    try { await this.ready() }
    catch { this.connection = 'Local workspace' }
    if (this.connection.startsWith('Muse ')) {
      const results = await Promise.allSettled([
        this.host.request<ModelListResult>('model/list'),
        execute(museExecutable(), ['skills', 'list', '--json'], { env: museEnvironment(), timeout: 15000, maxBuffer: 5 * 1024 * 1024 })
      ])
      if (results[0].status === 'fulfilled') this.models = results[0].value.models
      if (results[1].status === 'fulfilled') this.skills = JSON.parse(results[1].value.stdout).skills.map((s: any) => ({ id: s.id, name: s.name ?? s.id, description: s.description ?? s.short_description ?? '' }))
    }
    this.flush()
    return { workspace: liveWorkspace(this.store.state), skills: this.skills, models: this.models, host: this.connection }
  }
  /** Store a custom theme colour. Null/empty clears it back to the per-mode
   *  default; an invalid value is ignored. Returns whether state changed. */
  private setThemeColor(key: 'themeBackground' | 'themeAccent', raw: unknown): boolean {
    if (raw === null || (typeof raw === 'string' && raw.trim() === '') || raw === undefined) {
      if (this.store.state[key] === undefined) return false
      this.store.state[key] = undefined
      return true
    }
    const color = normalizeThemeColor(raw)
    if (!color || this.store.state[key] === color) return false
    this.store.state[key] = color
    return true
  }
  private repo(value: unknown): string {
    if (typeof value !== 'string' || !isAbsolute(value) || !statSync(value).isDirectory()) throw new Error('Choose an existing folder.')
    return value
  }
  private contextName(repo: string, raw: unknown): string {
    const name = typeof raw === 'string' ? raw.trim().slice(0, 60) : ''
    if (name) return name
    const count = this.store.state.contexts.filter(c => c.repo === repo).length
    return `Session ${count + 1}`
  }
  private taskBriefing(repo: string, id: string) {
    const task = this.boardStore.query(repo, { type: 'read', id }) as BoardNote | null
    if (!task || task.kind !== 'task') throw new Error('Task no longer exists.')
    const related = this.boardStore.query(repo, { type: 'related', id }) as BoardNote[]
    const summary = this.boardStore.query(repo, { type: 'summary' }) as { total: number; byKind: Record<string, number> }
    const context = related.filter(note => note.kind === 'context').slice(0, 6)
    const recentContext = (this.boardStore.query(repo, { type: 'search', kind: 'context', limit: 200 }) as BoardNote[]).filter(note => !context.some(linked => linked.id === note.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6)
    return `Work on Agent Hub task ${task.id}: ${task.title}\n\n${task.body || 'Read the task note for its full brief.'}\n\nAcceptance checks:\n${task.acceptance?.length ? task.acceptance.map(item => `- ${item}`).join('\n') : '- Define and verify a concrete outcome.'}\n\nImages to inspect:\n${task.images?.length ? task.images.map(image => `- ${join(repo, image.path)}${image.description ? ` — ${image.description}` : ''}`).join('\n') : '- None attached.'}\n\nThe Tasks canvas is the repository's shared context (${summary.total} notes, ${summary.byKind.context ?? 0} codebase context notes). Read .agents-hub/README.md and .agents-hub/notes/${task.id}.md. Query the board for other relevant tasks, notes, and context before changing code. Linked context:\n${context.length ? context.map(note => `- ${note.id} ${note.title}: ${note.body.slice(0, 280)}`).join('\n') : '- None linked.'}\n\nOther codebase context to check:\n${recentContext.length ? recentContext.map(note => `- ${note.id} ${note.title}`).join('\n') : '- None.'}\n\nBoard command: ELECTRON_RUN_AS_NODE=1 "$AGENT_HUB_BOARD_RUNTIME" "$AGENT_HUB_BOARD_CLI" summary (or search '{"kind":"context"}'; read '"${task.id}"'). If the command is unavailable, read and edit repo-local board files directly. Keep this Task status current. After coding, record a concise, evidence-backed codebase learning in a Context note and complete the Task with outcome and acceptance checks. Use board_complete_task through the board MCP server or the board CLI; give a no-learning reason only if nothing durable was learned.`
  }
  private boardBriefing(repo: string, sessionId: string) {
    const snapshot = this.boardStore.load(repo)
    const active = snapshot.notes.filter(note => note.kind === 'task' && note.sessionId === sessionId && note.status === 'working').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
    const context = snapshot.notes.filter(note => note.kind === 'context').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8)
    return `You are working in Agent Hub for ${repo}. The Tasks canvas is shared repository memory, stored in .agents-hub/notes/*.md; .agents-hub/canvas.json stores positions and sections. Read .agents-hub/README.md first.\n\nStart by reviewing the board and relevant notes. In this terminal run ELECTRON_RUN_AS_NODE=1 "$AGENT_HUB_BOARD_RUNTIME" "$AGENT_HUB_BOARD_CLI" summary, then search '{"kind":"context"}' and read relevant Task and Context notes. If those tools are unavailable, read the Markdown files directly.\n\n${active ? `Active Task: ${active.id} ${active.title}. Read .agents-hub/notes/${active.id}.md and keep its status current.\n\n` : ''}Recent codebase context:\n${context.length ? context.map(note => `- ${note.id} ${note.title}: ${note.body.slice(0, 180)}`).join('\n') : '- None yet.'}\n\nUse the board as context while coding. At the end of a Task, update its outcome and acceptance checks and record one concise codebase learning with evidence paths in a Context note. Use the board CLI or MCP complete-task tool when available.`
  }
  private terminalResource(contextId: string, repo: string, args: Record<string, any>): TerminalResource {
    const kind: TerminalKind = ['shell', 'custom', 'codex', 'claude', 'cursor'].includes(args.terminalKind) ? args.terminalKind : 'muse'
    const now = new Date().toISOString()
    let profile: TerminalProfile | undefined
    let agent = kind === 'muse' ? 'Muse' : kind === 'shell' ? 'Shell' : 'Agent'
    if (isBuiltinAgent(kind)) {
      profile = nativeProfile(kind, args.providerModel)
      agent = profile.label
    } else if (kind === 'custom') {
      const raw = args.profile && typeof args.profile === 'object' ? args.profile as Record<string, unknown> : {}
      const label = typeof raw.label === 'string' ? raw.label.trim().slice(0, 80) : ''
      const executable = typeof raw.executable === 'string' ? raw.executable.trim().slice(0, 300) : ''
      const argv = Array.isArray(raw.args) ? raw.args : []
      profile = customProfile(label, executable, argv)
      agent = profile.label
    }
    const requestedName = typeof args.terminalName === 'string' ? args.terminalName.trim().slice(0, 60) : ''
    return {
      id: `res-${uuid()}`, contextId, repo, name: requestedName || agent, agent, terminalKind: kind, profile,
      launch: normalizeLaunch(args.launch), draft: emptyDraft(), terminalRunning: false, createdAt: now, updatedAt: now,
    }
  }
  private contextForResource(id: string) { return this.store.state.contexts.find(context => context.terminals.some(resource => resource.id === id)) }
  async invoke(action: string, args: Record<string, any> = {}): Promise<any> {
    switch (action) {
      case 'bootstrap': return this.bootstrap()
      case 'terminalProviders': return availableAgents()
      case 'selectRepo': {
        // Selecting never records: the browser can visit any folder without
        // saving it. Only creating a context makes a folder known.
        const repo = this.repo(args.repo)
        this.store.state.selectedRepo = repo; this.flush(); return liveWorkspace(this.store.state)
      }
      case 'listDir': {
        const raw = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : homedir()
        if (!isAbsolute(raw)) throw new Error('Invalid folder.')
        const dir = normalize(raw)
        let names: string[]
        try { names = readdirSync(dir) } catch { throw new Error(`Cannot read ${dir}.`) }
        const entries: { name: string; path: string }[] = []
        for (const name of names) {
          const full = join(dir, name)
          try { if (statSync(full).isDirectory()) entries.push({ name, path: full }) } catch { /* raced deletion, skip */ }
        }
        entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        return { path: dir, home: homedir(), entries }
      }
      case 'selectContext': {
        const context = this.store.context(String(args.id))
        this.store.state.selectedRepo = context.repo
        ;(this.store.state.selectedContexts ??= {})[context.repo] = context.id
        this.flush(); return liveWorkspace(this.store.state)
      }
      case 'newContext': {
        const repo = this.repo(args.repo)
        const contextId = `ctx-${uuid()}`
        const context = newContext(contextId, repo, this.contextName(repo, args.name), this.terminalResource(contextId, repo, args))
        this.store.state.contexts.push(context)
        if (!this.store.state.repos.includes(repo)) this.store.state.repos.push(repo)
        this.store.state.selectedRepo = repo
        ;(this.store.state.selectedContexts ??= {})[repo] = context.id
        this.flush(); return context
      }
      case 'newTerminal': {
        const context = this.store.context(String(args.contextId))
        const resource = this.terminalResource(context.id, context.repo, args)
        context.terminals.push(resource); context.updatedAt = new Date().toISOString()
        this.syncContextProjection(context); this.flush(); return resource
      }
      case 'deleteContext': {
        const id = String(args.id)
        const context = this.store.context(id)
        for (const resource of context.terminals) this.terminals.stop(resource.id).catch(() => {})
        this.store.state.contexts = this.store.state.contexts.filter(c => c.id !== id)
        for (const [repo, selected] of Object.entries(this.store.state.selectedContexts ?? {})) {
          if (selected === id) {
            const fallback = this.store.state.contexts.find(c => c.repo === repo)
            if (fallback) this.store.state.selectedContexts![repo] = fallback.id
            else delete this.store.state.selectedContexts![repo]
          }
        }
        this.flush(); return null
      }
      case 'deleteTerminal': {
        const resource = this.store.resource(String(args.id))
        const context = this.store.context(resource.contextId)
        if (context.terminals.length <= 1) throw new Error('A Session must keep at least one terminal. Add another terminal before removing this one.')
        this.terminals.stop(resource.id).catch(() => {})
        context.terminals = context.terminals.filter(item => item.id !== resource.id)
        context.updatedAt = new Date().toISOString(); this.syncContextProjection(context); this.flush(); return null
      }
      case 'terminalOpen': {
        const resource = this.store.resource(String(args.id))
        const context = this.store.context(resource.contextId)
        const themeEnv = themeEnvironment(this.store.state.themeBackground, this.store.state.themeAccent)
        const existing = this.opens.get(resource.id); if (existing) return existing
        const operation = (async () => {
          let tasks: BoardNote[] = []
          try { tasks = this.boardStore.load(resource.repo).notes.filter(note => note.kind === 'task' && note.sessionId === context.id && note.status === 'working') }
          catch { /* a damaged board should not prevent opening a terminal */ }
          const activeTask = tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
          const boardEnv = { ...themeEnv, AGENT_HUB_REPO: resource.repo, AGENT_HUB_BOARD_RUNTIME: process.execPath, ...(this.boardCliPath ? { AGENT_HUB_BOARD_CLI: this.boardCliPath } : {}), ...(activeTask ? { AGENT_HUB_ACTIVE_TASK_ID: activeTask.id } : {}) }
          const snapshot = await this.terminals.open(resource.id, null, resource.repo, args.cols, args.rows, resource.launch, resource.terminalKind, boardEnv, resource.profile)
          resource.terminalRunning = snapshot.running
          resource.updatedAt = new Date().toISOString(); context.updatedAt = resource.updatedAt
          this.syncContextProjection(context); this.flush()
          if (!snapshot.running) {
            const tail = this.terminals.screenText(resource.id).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trim().slice(-400)
            throw new Error(`${resource.agent} exited before the terminal attached.${tail ? ` Output: ${tail}` : ''}`)
          }
          return snapshot
        })()
        this.opens.set(resource.id, operation)
        try { return await operation } finally { this.opens.delete(resource.id) }
      }
      case 'terminalClose': {
        const id = String(args.id); await this.terminals.stop(id)
        return null
      }
      case 'patchContext': {
        const context = this.store.context(String(args.id)), patch = args.patch ?? {}
        if (typeof patch.name === 'string' && patch.name.trim()) context.name = patch.name.trim().slice(0, 60)
        // Read/write the first-resource projection for older clients while the
        // renderer uses patchTerminal for resource-owned fields.
        const first = context.terminals[0]
        if (first && patch.launch && typeof patch.launch === 'object') {
          if (this.terminals.running(first.id)) throw new Error('Stop the terminal before changing Muse model and effort. They apply on next open.')
          first.launch = normalizeLaunch({ ...first.launch, ...patch.launch })
        }
        if (first && patch.draft && typeof patch.draft.html === 'string' && typeof patch.draft.text === 'string' && Array.isArray(patch.draft.attachments)) {
          if (patch.draft.html.length > 1_000_000) throw new Error('This draft is too large.')
          for (const attachment of patch.draft.attachments) this.attachmentPath(attachment.id)
          first.draft = { ...patch.draft, attachments: patch.draft.attachments.map(({ preview, path, ...metadata }: Attachment) => metadata) }
        }
        this.syncContextProjection(context)
        if (Object.keys(patch).every(k => k === 'draft')) {
          clearTimeout(this.draftTimer); this.draftTimer = setTimeout(() => this.store.save(), 500)
          return null
        }
        context.updatedAt = new Date().toISOString()
        this.flush(); return liveContext(context)
      }
      case 'patchTerminal': {
        const resource = this.store.resource(String(args.id)), context = this.store.context(resource.contextId), patch = args.patch ?? {}
        if (patch.launch && typeof patch.launch === 'object') {
          if (this.terminals.running(resource.id)) throw new Error('Stop the terminal before changing Muse model and effort. They apply on next open.')
          resource.launch = normalizeLaunch({ ...resource.launch, ...patch.launch })
        }
        if (patch.name !== undefined && typeof patch.name === 'string' && patch.name.trim()) resource.name = patch.name.trim().slice(0, 60)
        if (patch.draft && typeof patch.draft.html === 'string' && typeof patch.draft.text === 'string' && Array.isArray(patch.draft.attachments)) {
          if (patch.draft.html.length > 1_000_000) throw new Error('This draft is too large.')
          for (const attachment of patch.draft.attachments) this.attachmentPath(attachment.id)
          resource.draft = { ...patch.draft, attachments: patch.draft.attachments.map(({ preview, path, ...metadata }: Attachment) => metadata) }
        }
        resource.updatedAt = new Date().toISOString(); context.updatedAt = resource.updatedAt
        this.syncContextProjection(context)
        if (Object.keys(patch).every(k => k === 'draft')) {
          clearTimeout(this.draftTimer); this.draftTimer = setTimeout(() => this.store.save(), 500)
          return null
        }
        this.flush(); return liveResource(resource)
      }
      case 'tickets:list': {
        const repo = this.repo(args.repo)
        this.ticketStore.watchRepo(repo)
        return this.ticketStore.list(repo)
      }
      case 'tickets:create': {
        const repo = this.repo(args.repo), input = (args.ticket ?? {}) as Partial<Ticket>
        if (input.contextId) {
          const context = this.store.state.contexts.find(item => item.id === input.contextId && item.repo === repo)
          if (!context) throw new Error('Choose a Session in this workspace.')
          input.contextName = context.name
        } else input.contextName = ''
        return this.ticketStore.create(repo, input)
      }
      case 'tickets:update': {
        const repo = this.repo(args.repo), patch = (args.patch ?? {}) as Partial<Ticket>
        if (patch.contextId) {
          const context = this.store.state.contexts.find(item => item.id === patch.contextId && item.repo === repo)
          if (!context) throw new Error('Choose a Session in this workspace.')
          patch.contextName = context.name
        } else if (patch.contextId === '') patch.contextName = ''
        return this.ticketStore.update(repo, String(args.id), patch, typeof args.expectedUpdatedAt === 'string' ? args.expectedUpdatedAt : undefined)
      }
      case 'board:load': return this.boardStore.load(this.repo(args.repo))
      case 'board:query': return this.boardStore.query(this.repo(args.repo), args.query as BoardQuery)
      case 'board:apply': return this.boardStore.apply(this.repo(args.repo), args.command as BoardCommand)
      case 'board:image:add': return this.boardStore.saveImage(this.repo(args.repo), args.name, args.mime, args.base64)
      case 'board:image:preview': return this.boardStore.imagePreview(this.repo(args.repo), args.id)
      case 'board:organizer:get': return { config: this.organizer.config(this.repo(args.repo)), last: this.organizer.lastChange(this.repo(args.repo)) }
      case 'board:organizer:save': return this.organizer.saveConfig(this.repo(args.repo), args.config)
      case 'board:organizer:run': return this.organizer.run(this.repo(args.repo))
      case 'board:organizer:undo': return this.organizer.undo(this.repo(args.repo))
      case 'dictation:start': return this.dictation.start()
      case 'dictation:stop': return this.dictation.stop()
      case 'dictation:cancel': this.dictation.cancel(); return null
      case 'board:briefing': return this.taskBriefing(this.repo(args.repo), String(args.id))
      case 'board:handoff': return this.boardBriefing(this.repo(args.repo), String(args.sessionId))
      case 'preferences': {
        let themeChanged = false
        if (['dark', 'light', 'system'].includes(args.theme)) {
          // A preset defines the grounds: switching presets drops a custom
          // background so the buttons always visibly work. A custom accent
          // survives (it suits either preset), and an explicit
          // themeBackground in the same call wins over the clear.
          if (args.theme !== this.store.state.theme && !('themeBackground' in args) && this.setThemeColor('themeBackground', null)) themeChanged = true
          this.store.state.theme = args.theme; themeChanged = true
        }
        if ('themeBackground' in args && this.setThemeColor('themeBackground', args.themeBackground)) themeChanged = true
        if ('themeAccent' in args && this.setThemeColor('themeAccent', args.themeAccent)) themeChanged = true
        if (typeof args.repo === 'string' && args.viewport) {
          const { x, y, zoom } = args.viewport
          if ([x, y, zoom].every(Number.isFinite) && zoom >= 0.05 && zoom <= 2) this.store.state.viewports[args.repo] = { x, y, zoom }
        }
        this.store.save(); if (themeChanged) this.emit('workspace', liveWorkspace(this.store.state)); return null
      }
      case 'attachmentPreview': {
        if (!/^image\/(png|jpeg|webp|gif)$/.test(String(args.mime))) return null
        return `data:${args.mime};base64,${readFileSync(this.attachmentPath(args.id)).toString('base64')}`
      }
      case 'attachment': return this.saveAttachment(args)
      case 'attachmentPath': {
        const resource = this.store.resource(String(args.id))
        const attachment = resource.draft.attachments.find(a => a.id === String(args.attachmentId))
        if (!attachment) throw new Error('This attachment is no longer in the draft.')
        return this.attachmentPath(attachment.id)
      }
      case 'newSession':
      case 'patchSession':
      case 'read':
      case 'leaveChat':
        throw new Error('Provider sessions are managed inside their terminal. Agent Hub stores workspace tickets and terminal resources.')
      case 'send':
      case 'interrupt':
      case 'setModel':
      case 'approval':
      case 'answer':
      case 'fork':
        throw new Error('Structured chat actions are not available for generic CLI agents.')
      default: throw new Error(`Unknown action: ${action}`)
    }
  }
  private attachmentPath(id: unknown) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid attachment.')
    return join(this.store.directory, 'attachments', id)
  }
  saveAttachment(args: Record<string, any>): Attachment {
    if (typeof args.base64 !== 'string' || args.base64.length > 28_000_000) throw new Error('Attachments must be smaller than 20 MB.')
    const data = Buffer.from(args.base64, 'base64')
    if (!data.length || data.length > 20 * 1024 * 1024) throw new Error('This attachment is empty or larger than 20 MB.')
    const id = uuid(), name = basename(String(args.name || 'attachment'))
    const mime = String(args.mime || 'application/octet-stream')
    mkdirSync(join(this.store.directory, 'attachments'), { recursive: true })
    writeFileSync(this.attachmentPath(id), data, { mode: 0o600 })
    return { id, name, mime, size: data.length, path: this.attachmentPath(id), ...(/^image\/(png|jpeg|webp|gif)$/.test(mime) ? { preview: `data:${mime};base64,${args.base64}` } : {}) }
  }
  close() { clearTimeout(this.flushTimer); clearTimeout(this.draftTimer); this.ticketStore.close(); this.boardStore.close(); this.dictation.close(); this.flush(); this.terminals.close(); this.host.stop() }
}
