import { EventEmitter } from 'node:events'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { join, basename, extname, isAbsolute, normalize, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { v7 as uuid } from 'uuid'
import { Store, newContext, newProject, projectFolders, emptyDraft, liveContext, liveResource, liveWorkspace, PROJECT_COLORS } from './store'
import { Terminals, type TerminalHost } from './terminals'
import { agentEnvironment, availableAgents, customProfile, isBuiltinAgent, nativeProfile } from './provider-profiles'
import { launchPlan, providerFor, writeBoardShim } from './agent-integration'
import { ActivityTracker } from './agent-activity'
import { AgentEventServer } from './agent-events'
import { contextFreshness } from './freshness'
import { assertWorktreePath, createWorktree, removeWorktree, worktreeStatus } from './worktrees'
import { DictationService } from './dictation'
import { BoardOrganizer } from './board-organizer'
import { TicketStore } from './tickets'
import { BoardStore } from './board-store'
import type { BoardCommand, BoardNote, BoardQuery } from '../shared/board'
import type { Attachment, Bootstrap, Project, RepoContext, TerminalKind, TerminalProfile, TerminalResource, Ticket } from '../src/types'
import { normalizeThemeColor, themeEnvironment } from '../src/theme'

/** Screen text of a startup or confirmation dialog that typed input would answer. */
const BLOCKING_PROMPT = /trust this (folder|directory|workspace)|Do you trust|Enter to confirm|Press Enter to continue|\(y\/n\)|\[y\/N\]|\[Y\/n\]/i
const MIME_EXTENSIONS: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf', 'text/plain': '.txt' }

/** Agent Hub stores repo-local tickets, named terminal contexts, and terminal
 *  resources. Provider-specific controls stay optional; every agent can run as
 *  a normal executable in a supervised PTY. */
export class HubService extends EventEmitter {
  store: Store
  terminals: TerminalHost
  ticketStore = new TicketStore()
  boardStore = new BoardStore()
  dictation = new DictationService()
  organizer = new BoardOrganizer(this.boardStore)
  private draftTimer?: NodeJS.Timeout
  private pendingResources = new Set<string>()
  private opens = new Map<string, Promise<{ data: string; seq: number; cols: number; rows: number; running: boolean }>>()
  private flushTimer?: NodeJS.Timeout
  /** Directory holding the `agent-hub-board` command, prepended to terminal PATHs. */
  private boardBin = ''
  activity = new ActivityTracker()
  private events: AgentEventServer
  /** Messages waiting for their terminal's agent to be idle, per terminal. */
  private outbox = new Map<string, string[]>()
  /** Questions already seen per repo (task id + time asked), so only new ones notify. */
  private seenQuestions = new Map<string, Set<string>>()
  /** Terminals launched to resume a conversation, with their start time, so
   *  a resume the agent rejects can fall back to a fresh conversation. */
  private resumes = new Map<string, number>()
  constructor(directory: string, initialRepo = process.cwd(), private boardCliPath = '', terminals: TerminalHost = new Terminals()) {
    super(); this.store = new Store(directory, initialRepo); this.terminals = terminals
    this.events = new AgentEventServer((id, payload) => this.agentEvent(id, payload), join(directory, 'agent-events.json'))
    if (boardCliPath) {
      try { this.boardBin = writeBoardShim(directory, { runtime: process.execPath, cli: boardCliPath }) }
      catch { /* terminals still get AGENT_HUB_BOARD_RUNTIME and AGENT_HUB_BOARD_CLI */ }
    }
    this.ticketStore.on('change', snapshot => this.emit('tickets', snapshot))
    this.boardStore.on('change', snapshot => { this.emit('board', snapshot); this.noticeQuestions(snapshot) })
    this.terminals.on('data', event => {
      this.emit('terminal', event)
      this.activity.output(event.id)
    })
    this.terminals.on('input', event => this.activity.input(event.id, event.data))
    this.terminals.on('attention', event => this.activity.attention(event.id, event.message))
    this.terminals.on('exit', event => {
      this.emit('terminal', event)
      this.activity.exit(event.id, event.exitCode)
      let resource: TerminalResource
      try { resource = this.store.resource(event.id); resource.terminalRunning = false } catch { return }
      const resumedAt = this.resumes.get(event.id)
      this.resumes.delete(event.id)
      if (resumedAt !== undefined && event.exitCode && Date.now() - resumedAt < 8000) {
        // The agent refused to resume (the conversation was deleted or
        // belongs elsewhere): start a fresh one instead of a dead terminal.
        resource.conversationId = undefined
        void this.invoke('terminalOpen', { id: event.id, fresh: true }).catch(() => {})
      }
      this.changed(event.id)
    })
    this.activity.on('change', (id: string, activity) => {
      let resource: TerminalResource
      try { resource = this.store.resource(id) } catch { return }
      if (activity.state === 'idle') setTimeout(() => this.flushOutbox(id), 400)
      const previous = resource.activity
      resource.activity = activity
      this.emit('activity', { resource: liveResource(resource), previous })
      this.changed(id)
    })
  }
  /** Mark terminals the supervisor kept running while the app was closed
   *  as running again, so their views reattach instead of starting fresh. */
  adoptRunning() {
    // Their hooks post to the saved port, so listen before anything happens.
    if (this.terminals.runningIds().length) void this.events.start().catch(() => {})
    for (const id of this.terminals.runningIds()) {
      let resource: TerminalResource
      try { resource = this.store.resource(id) } catch { continue }
      resource.terminalRunning = true
      this.activity.adopt(id, { hooks: !!(resource.profile && providerFor(resource.terminalKind, resource.profile.executable)) })
    }
    this.flush()
  }
  /** Type a message into an agent's terminal as its next prompt. It is sent
   *  once the agent is idle (never over a permission prompt or mid-turn), so
   *  a briefing or an answer can be handed over while the agent is busy. */
  async deliver(id: string, message: string): Promise<'sent' | 'queued'> {
    const queue = this.outbox.get(id) ?? []
    queue.push(message)
    this.outbox.set(id, queue)
    await this.flushOutbox(id)
    return queue.includes(message) ? 'queued' : 'sent'
  }
  private flushing = new Set<string>()
  private async flushOutbox(id: string) {
    const queue = this.outbox.get(id)
    if (!queue?.length || !this.terminals.running(id) || this.flushing.has(id)) return
    const state = this.activity.get(id)?.state
    if (state && state !== 'idle') return
    // Never type into a dialog: a message's Enter would answer it.
    this.flushing.add(id)
    let screen = ''
    try { screen = await this.terminals.peek(id) } catch { /* treat an unreadable screen as clear */ } finally { this.flushing.delete(id) }
    if (BLOCKING_PROMPT.test(screen.slice(-2500))) { this.activity.attention(id, 'Answer the prompt in the terminal'); return }
    if (!this.outbox.get(id)?.length || this.activity.get(id)?.state !== state) return
    const message = queue.shift()!
    if (!queue.length) this.outbox.delete(id)
    this.terminals.write(id, `\x1b[200~${message}\x1b[201~`)
    // Submit after the paste lands, then send any further queued message.
    setTimeout(() => { this.terminals.write(id, '\r'); if (this.outbox.has(id)) setTimeout(() => this.flushOutbox(id), 400) }, 150)
  }
  /** Emit `question` for each Task question that appeared since the last
   *  snapshot of this repo, and `questions` with every open one. */
  private noticeQuestions(snapshot: { repo: string; notes: BoardNote[] }) {
    const open = snapshot.notes.filter(note => note.question)
    const seen = this.seenQuestions.get(snapshot.repo)
    const keys = new Set(open.map(note => `${note.id}@${note.question!.askedAt}`))
    if (seen) for (const note of open) if (!seen.has(`${note.id}@${note.question!.askedAt}`)) this.emit('question', { repo: snapshot.repo, note })
    this.seenQuestions.set(snapshot.repo, keys)
    this.emit('questions', { repo: snapshot.repo, count: open.length })
  }
  /** A structured event from an agent's hooks. Once the person has sent a
   *  message, the agent's conversation id is kept so reopening resumes it. */
  private agentEvent(id: string, payload: Record<string, unknown>) {
    this.activity.hook(id, payload)
    const conversation = this.activity.providerSession(id)
    const name = String(payload.hook_event_name ?? payload.type ?? '')
    if (!conversation || !['UserPromptSubmit', 'PreToolUse', 'Stop', 'agent-turn-complete'].includes(name)) return
    try {
      const resource = this.store.resource(id)
      if (resource.conversationId !== conversation) { resource.conversationId = conversation; this.changed(id) }
    } catch { /* deleted terminal */ }
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
    this.store.save()
    this.emit('workspace', liveWorkspace(this.store.state))
  }
  bootstrap(): Bootstrap {
    this.flush()
    return { workspace: liveWorkspace(this.store.state) }
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
    if (typeof value !== 'string' || !isAbsolute(value) || !statSync(value, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Choose an existing folder${typeof value === 'string' ? `: ${value} is missing` : ''}.`)
    return value
  }
  private contextName(projectId: string, raw: unknown): string {
    const name = typeof raw === 'string' ? raw.trim().slice(0, 60) : ''
    if (name) return name
    const count = this.store.state.contexts.filter(c => c.projectId === projectId).length
    return `Session ${count + 1}`
  }
  /** The project a request names: its id, its board root (what the
   *  renderer sends as `repo` for board calls), or one of its folders. */
  private projectFrom(value: unknown): Project {
    if (typeof value === 'string' && value.startsWith('prj-')) return this.store.project(value)
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Choose a project.')
    const byBoard = this.store.projectForBoard(value)
    if (byBoard) return byBoard
    const folder = normalize(value).replace(/(.)\/+$/, '$1')
    const owner = this.store.state.projects.find(project => project.folders.some(item => item.path === folder))
    if (!owner) throw new Error('This folder is not in a project. Add it to one first.')
    return owner
  }
  /** A project's board root, ready to use: created, with a migrated
   *  repository board copied in once, and project.json describing its
   *  folders for the board CLI and MCP server. */
  private board(value: unknown): string {
    const project = this.projectFrom(value)
    this.prepareBoard(project)
    return project.boardRoot
  }
  private prepareBoard(project: Project) {
    mkdirSync(project.boardRoot, { recursive: true, mode: 0o700 })
    const hub = join(project.boardRoot, '.agents-hub')
    if (project.importFrom) {
      const source = join(project.importFrom, '.agents-hub')
      if (!existsSync(hub) && existsSync(source)) cpSync(source, hub, { recursive: true, filter: path => !path.endsWith('.write-lock') })
      delete project.importFrom
      this.store.save()
    }
    const manifest = JSON.stringify({ id: project.id, name: project.name, description: project.description, folders: project.folders }, null, 2)
    const file = join(project.boardRoot, 'project.json')
    let current = ''
    try { current = readFileSync(file, 'utf8') } catch { /* first write */ }
    if (current !== manifest) writeFileSync(file, manifest, { mode: 0o600 })
  }
  private primaryFolder(project: Project) {
    const primary = project.folders[0]?.path
    if (!primary) throw new Error(`Add a folder to ${project.name} first.`)
    return primary
  }
  /** Agent-facing description of a project's folders. */
  private projectBrief(project: Project, cwd?: string) {
    const folders = project.folders.map((folder, index) => `- ${folder.path}${folder.label ? ` (${folder.label})` : ''}${index === 0 ? ' [primary]' : ''}${folder.note ? `: ${folder.note}` : ''}`).join('\n')
    return `You are working in the Agent Hub project "${project.name}"${project.description ? `: ${project.description}` : ''}. The project spans these folders, and you have access to all of them:\n${folders}${cwd && cwd !== project.folders[0]?.path ? `\nYour working directory is ${cwd}.` : ''}\nThe project's shared board of tasks, notes, and codebase context is available through the board_* MCP tools or the agent-hub-board command. Evidence paths in context notes are absolute or relative to the primary folder.`
  }
  private taskBriefing(repo: string, id: string) {
    const project = this.store.projectForBoard(repo)
    const task = this.boardStore.query(repo, { type: 'read', id }) as BoardNote | null
    if (!task || task.kind !== 'task') throw new Error('Task no longer exists.')
    const related = this.boardStore.query(repo, { type: 'related', id }) as BoardNote[]
    const summary = this.boardStore.query(repo, { type: 'summary' }) as { total: number; byKind: Record<string, number> }
    const context = related.filter(note => note.kind === 'context').slice(0, 6)
    const recentContext = (this.boardStore.query(repo, { type: 'search', kind: 'context', limit: 200 }) as BoardNote[]).filter(note => !context.some(linked => linked.id === note.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6)
    return `Work on Agent Hub task ${task.id}: ${task.title}\n\n${project ? `${this.projectBrief(project)}\n\n` : ''}${task.body || 'Read the task note for its full brief.'}\n\n${task.worktree ? `You are working in your own git worktree at ${task.worktree.path} on branch ${task.worktree.branch}, started from ${task.worktree.base.slice(0, 10)}. Other agents work on sibling tasks in parallel in their own worktrees. Commit your work on this branch and do not modify the main checkout at ${project ? this.primaryFolder(project) : repo}. Dependencies may need installing in this worktree.\n\n` : ''}Acceptance checks:\n${task.acceptance?.length ? task.acceptance.map(item => `- ${item}`).join('\n') : '- Define and verify a concrete outcome.'}\n\nImages to inspect:\n${task.images?.length ? task.images.map(image => `- ${join(repo, image.path)}${image.description ? ` — ${image.description}` : ''}`).join('\n') : '- None attached.'}\n\nThe Tasks canvas is the repository's shared context (${summary.total} notes, ${summary.byKind.context ?? 0} codebase context notes). Read .agents-hub/README.md and .agents-hub/notes/${task.id}.md. Query the board for other relevant tasks, notes, and context before changing code. Linked context:\n${context.length ? context.map(note => `- ${note.id} ${note.title}: ${note.body.slice(0, 280)}`).join('\n') : '- None linked.'}\n\nOther codebase context to check:\n${recentContext.length ? recentContext.map(note => `- ${note.id} ${note.title}`).join('\n') : '- None.'}\n\nBoard tools: use the board_* MCP tools, or run agent-hub-board summary (then search '{"kind":"context"}', read '"${task.id}"'). Without either, read the note files directly. Log meaningful steps with board_log_progress (agent-hub-board log \"...\") so progress shows on the canvas; if you need a decision, ask with board_ask and end your turn, and the answer will be typed here. After coding, complete the Task with board_complete_task (agent-hub-board complete-task): give the outcome, checked acceptance criteria, and one concise, evidence-backed codebase learning as a Context change, or a no-learning reason only if nothing durable was learned.`
  }
  private boardBriefing(repo: string, sessionId: string) {
    const snapshot = this.boardStore.load(repo)
    const active = snapshot.notes.filter(note => note.kind === 'task' && note.sessionId === sessionId && note.status === 'working').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
    const context = snapshot.notes.filter(note => note.kind === 'context').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8)
    const project = this.store.projectForBoard(repo)
    return `${project ? this.projectBrief(project) : `You are working in Agent Hub for ${repo}.`} The Tasks canvas is the project's shared memory, stored in ${join(repo, '.agents-hub')}/notes/*.md.\n\nStart by reviewing the board and relevant notes with the board_* MCP tools, or run agent-hub-board summary, then search '{"kind":"context"}' and read relevant Task and Context notes. If neither is available, read the Markdown files directly.\n\n${active ? `Active Task: ${active.id} ${active.title}. Read .agents-hub/notes/${active.id}.md and keep its status current.\n\n` : ''}Recent codebase context:\n${context.length ? context.map(note => `- ${note.id} ${note.title}: ${note.body.slice(0, 180)}`).join('\n') : '- None yet.'}\n\nUse the board as context while coding. At the end of a Task, update its outcome and acceptance checks and record one concise codebase learning with evidence paths in a Context note. Use board_complete_task (agent-hub-board complete-task) when available.`
  }
  private terminalResource(contextId: string, repo: string, args: Record<string, any>): TerminalResource {
    const kind: TerminalKind = ['shell', 'custom', 'codex', 'claude', 'cursor'].includes(args.terminalKind) ? args.terminalKind : 'shell'
    const now = new Date().toISOString()
    let profile: TerminalProfile | undefined
    let agent = kind === 'shell' ? 'Shell' : 'Agent'
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
      ...(typeof args.cwd === 'string' && args.cwd ? (assertWorktreePath(repo, args.cwd), { cwd: args.cwd }) : {}),
      draft: emptyDraft(), terminalRunning: false, createdAt: now, updatedAt: now,
    }
  }
  /** Author shown on the canvas for an agent's board changes. */
  private agentName(resource: TerminalResource) { return resource.name === resource.agent ? resource.agent : `${resource.agent} · ${resource.name}` }
  /** Create a project from validated folders; the first is primary. A
   *  folder with an existing repository board seeds the project's board. */
  private createProject(input: Record<string, any>): Project {
    const folders = projectFolders(input.folders)
    if (!folders.length) throw new Error('Add at least one folder to the project.')
    for (const folder of folders) this.repo(folder.path)
    const legacy = folders.find(folder => existsSync(join(folder.path, '.agents-hub', 'notes')))?.path
    const project = newProject(this.store.directory, { ...input, folders, importFrom: legacy }, this.store.state.projects.length)
    this.store.state.projects.push(project)
    for (const folder of folders) if (!this.store.state.repos.includes(folder.path)) this.store.state.repos.push(folder.path)
    this.prepareBoard(project)
    return project
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
        this.store.state.selectedProject = context.projectId
        ;(this.store.state.selectedContexts ??= {})[context.projectId] = context.id
        this.flush(); return liveWorkspace(this.store.state)
      }
      case 'newContext': {
        // `project` names the project; a bare folder (`repo`) joins the
        // project that holds it, or becomes a new one-folder project.
        let project: Project
        if (args.project) project = this.projectFrom(args.project)
        else {
          const folder = this.repo(args.repo)
          project = this.store.state.projects.find(item => item.folders.some(entry => entry.path === folder)) ?? this.createProject({ folders: [folder] })
        }
        const primary = this.primaryFolder(project)
        const contextId = `ctx-${uuid()}`
        const context = newContext(contextId, project.id, primary, this.contextName(project.id, args.name), this.terminalResource(contextId, primary, args))
        this.store.state.contexts.push(context)
        this.store.state.selectedProject = project.id
        ;(this.store.state.selectedContexts ??= {})[project.id] = context.id
        this.flush(); return context
      }
      case 'project:create': {
        const project = this.createProject(args)
        this.store.state.selectedProject = project.id
        this.flush(); return project
      }
      case 'project:update': {
        const project = this.store.project(String(args.id)), patch = args.patch ?? {}
        if (typeof patch.name === 'string' && patch.name.trim()) project.name = patch.name.trim().slice(0, 80)
        if (typeof patch.description === 'string') project.description = patch.description.trim().slice(0, 2000)
        if (typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color)) project.color = patch.color.toLowerCase()
        if (patch.folders !== undefined) {
          const folders = projectFolders(patch.folders)
          if (!folders.length) throw new Error('A project needs at least one folder.')
          for (const folder of folders) this.repo(folder.path)
          project.folders = folders
        }
        project.updatedAt = new Date().toISOString()
        this.prepareBoard(project)
        this.flush(); return project
      }
      case 'project:select': {
        const project = this.store.project(String(args.id))
        this.store.state.selectedProject = project.id
        this.flush(); return liveWorkspace(this.store.state)
      }
      case 'project:delete': {
        // Stops and removes the project's Sessions. The board is kept in the
        // data directory under projects/deleted so nothing is lost.
        const project = this.store.project(String(args.id))
        for (const context of this.store.state.contexts.filter(item => item.projectId === project.id)) await this.invoke('deleteContext', { id: context.id })
        this.store.state.projects = this.store.state.projects.filter(item => item.id !== project.id)
        if (existsSync(project.boardRoot)) {
          const archive = join(this.store.directory, 'projects', 'deleted')
          mkdirSync(archive, { recursive: true })
          renameSync(project.boardRoot, join(archive, `${project.id}-${Date.now()}`))
        }
        if (this.store.state.selectedProject === project.id) this.store.state.selectedProject = this.store.state.projects[0]?.id
        this.flush(); return liveWorkspace(this.store.state)
      }
      case 'newTerminal': {
        const context = this.store.context(String(args.contextId))
        const resource = this.terminalResource(context.id, context.repo, args)
        context.terminals.push(resource); context.updatedAt = new Date().toISOString()
        this.flush(); return resource
      }
      case 'deleteContext': {
        const id = String(args.id)
        const context = this.store.context(id)
        for (const resource of context.terminals) { this.terminals.stop(resource.id).catch(() => {}); this.activity.forget(resource.id); this.outbox.delete(resource.id) }
        this.store.state.contexts = this.store.state.contexts.filter(c => c.id !== id)
        for (const [projectId, selected] of Object.entries(this.store.state.selectedContexts ?? {})) {
          if (selected === id) {
            const fallback = this.store.state.contexts.find(c => c.projectId === projectId)
            if (fallback) this.store.state.selectedContexts![projectId] = fallback.id
            else delete this.store.state.selectedContexts![projectId]
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
        this.activity.forget(resource.id); this.outbox.delete(resource.id)
        context.updatedAt = new Date().toISOString(); this.flush(); return null
      }
      case 'terminalOpen': {
        const resource = this.store.resource(String(args.id))
        const context = this.store.context(resource.contextId)
        const themeEnv = themeEnvironment(this.store.state.themeBackground, this.store.state.themeAccent)
        const existing = this.opens.get(resource.id); if (existing) return existing
        const project = this.store.project(context.projectId)
        const boardRoot = this.board(project.id)
        // Agents start in the primary folder (or their task's worktree) and
        // get every other project folder as an extra working directory.
        const cwd = resource.cwd ?? this.primaryFolder(project)
        const addDirs = project.folders.map(folder => folder.path).filter((path, index) => path !== cwd && !(resource.cwd && index === 0))
        const operation = (async () => {
          // The Session id lets board tools resolve the working Task on every
          // call, so a Task handed to an already-running agent is never stale.
          const boardEnv: Record<string, string> = {
            ...themeEnv, AGENT_HUB_BOARD_ROOT: boardRoot, AGENT_HUB_REPO: boardRoot, AGENT_HUB_PROJECT: project.name, AGENT_HUB_PROJECT_FOLDERS: project.folders.map(folder => folder.path).join('\n'),
            AGENT_HUB_SESSION_ID: context.id, AGENT_HUB_TERMINAL_ID: resource.id, AGENT_HUB_AGENT_NAME: this.agentName(resource),
            AGENT_HUB_BOARD_RUNTIME: process.execPath, ...(this.boardCliPath ? { AGENT_HUB_BOARD_CLI: this.boardCliPath } : {}),
            ...(this.boardBin ? { PATH: `${this.boardBin}${delimiter}${agentEnvironment().PATH}` } : {}),
          }
          let profile = resource.profile
          if (!this.terminals.running(resource.id)) {
            if (args.fresh) resource.conversationId = undefined
            const provider = profile ? providerFor(resource.terminalKind, profile.executable) : null
            let hookUrl: string | undefined
            if (provider) { try { hookUrl = await this.events.urlFor(resource.id) } catch { /* state falls back to screen signals */ } }
            const plan = launchPlan(provider, profile?.args ?? [], {
              repo: boardRoot, sessionId: context.id, terminalId: resource.id, agentName: this.agentName(resource), hookUrl, resumeId: resource.conversationId,
              addDirs, instructions: this.projectBrief(project, cwd),
              board: this.boardCliPath ? { runtime: process.execPath, cli: this.boardCliPath } : undefined,
            })
            if (profile) profile = { ...profile, args: plan.args }
            Object.assign(boardEnv, plan.env)
            if (resource.conversationId) this.resumes.set(resource.id, Date.now()); else this.resumes.delete(resource.id)
            this.activity.start(resource.id, { hooks: !!hookUrl, awaitReady: !!hookUrl && provider === 'claude' })
          }
          const snapshot = await this.terminals.open(resource.id, cwd, { kind: resource.terminalKind, profile, env: boardEnv, cols: args.cols, rows: args.rows })
          resource.terminalRunning = snapshot.running
          resource.updatedAt = new Date().toISOString(); context.updatedAt = resource.updatedAt
          this.flush()
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
        const id = String(args.id); this.resumes.delete(id); await this.terminals.stop(id)
        return null
      }
      case 'patchContext': {
        const context = this.store.context(String(args.id)), patch = args.patch ?? {}
        if (typeof patch.name === 'string' && patch.name.trim()) context.name = patch.name.trim().slice(0, 60)
        context.updatedAt = new Date().toISOString()
        this.flush(); return liveContext(context)
      }
      case 'patchTerminal': {
        const resource = this.store.resource(String(args.id)), context = this.store.context(resource.contextId), patch = args.patch ?? {}
        if (patch.name !== undefined && typeof patch.name === 'string' && patch.name.trim()) resource.name = patch.name.trim().slice(0, 60)
        if (patch.draft && typeof patch.draft.html === 'string' && typeof patch.draft.text === 'string' && Array.isArray(patch.draft.attachments)) {
          if (patch.draft.html.length > 1_000_000) throw new Error('This draft is too large.')
          for (const attachment of patch.draft.attachments) this.attachmentPath(attachment.id)
          resource.draft = { ...patch.draft, attachments: patch.draft.attachments.map(({ preview, path, ...metadata }: Attachment) => metadata) }
        }
        resource.updatedAt = new Date().toISOString(); context.updatedAt = resource.updatedAt
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
      case 'board:load': return this.boardStore.load(this.board(args.repo))
      case 'board:query': return this.boardStore.query(this.board(args.repo), args.query as BoardQuery)
      case 'board:apply': return this.boardStore.apply(this.board(args.repo), args.command as BoardCommand)
      case 'board:image:add': return this.boardStore.saveImage(this.board(args.repo), args.name, args.mime, args.base64)
      case 'board:image:preview': return this.boardStore.imagePreview(this.board(args.repo), args.id)
      case 'board:organizer:get': return { config: this.organizer.config(this.board(args.repo)), last: this.organizer.lastChange(this.board(args.repo)) }
      case 'board:organizer:save': return this.organizer.saveConfig(this.board(args.repo), args.config)
      case 'board:organizer:run': return this.organizer.run(this.board(args.repo))
      case 'board:organizer:undo': return this.organizer.undo(this.board(args.repo))
      case 'dictation:start': return this.dictation.start()
      case 'dictation:stop': return this.dictation.stop()
      case 'dictation:cancel': this.dictation.cancel(); return null
      case 'board:briefing': return this.taskBriefing(this.board(args.repo), String(args.id))
      case 'board:freshness': { const project = this.projectFrom(args.repo); return contextFreshness(project.folders.map(folder => folder.path), this.boardStore.load(this.board(project.id)).notes) }
      case 'board:answer': {
        const repo = this.board(args.repo), id = String(args.id)
        const before = this.boardStore.query(repo, { type: 'read', id }) as BoardNote | null
        const question = before?.question
        const note = this.boardStore.apply(repo, { type: 'answerQuestion', id, answer: String(args.answer ?? '') }) as BoardNote
        let delivery: 'sent' | 'queued' | 'none' = 'none'
        if (question?.terminalId) {
          try { this.store.resource(question.terminalId); delivery = await this.deliver(question.terminalId, `Answer to your question on Task ${id} ("${question.text}"):\n\n${String(args.answer).trim()}`) }
          catch { /* the asking terminal was deleted; the answer stays in the Task log */ }
        }
        return { note, delivery }
      }
      case 'board:fanout': {
        // One worktree, Session, and agent per open subtask, all at once.
        // Worktrees branch from the project's primary folder; the other
        // folders stay shared through --add-dir.
        const project = this.projectFrom(args.repo)
        const repo = this.board(project.id), primary = this.primaryFolder(project)
        const parent = this.boardStore.query(repo, { type: 'read', id: String(args.taskId) }) as BoardNote | null
        if (!parent || parent.kind !== 'task') throw new Error('Task no longer exists.')
        const children = (this.boardStore.query(repo, { type: 'search', kind: 'task', limit: 100 }) as BoardNote[])
          .filter(note => note.parentId === parent.id && note.status === 'open' && !note.worktree)
        if (!children.length) throw new Error('This task has no open subtasks to fan out. Split it first.')
        if (children.length > 8) throw new Error('Fan out at most 8 subtasks at once.')
        const started: Array<{ taskId: string; terminalId: string; branch: string }> = []
        for (const child of children) {
          const worktree = createWorktree(primary, child.id, child.title)
          const contextId = `ctx-${uuid()}`
          const resource = this.terminalResource(contextId, primary, { ...args, cwd: worktree.path, terminalName: args.terminalName || undefined })
          const context = newContext(contextId, project.id, primary, child.title.slice(0, 60), resource)
          this.store.state.contexts.push(context)
          const updated = this.boardStore.apply(repo, { type: 'updateNote', id: child.id, expectedRevision: child.revision, patch: { worktree, updatedBy: 'person' } }) as BoardNote
          this.flush()
          await this.invoke('board:dispatch', { repo, taskId: updated.id, terminalId: context.terminals[0].id })
          started.push({ taskId: child.id, terminalId: context.terminals[0].id, branch: worktree.branch })
        }
        this.boardStore.apply(repo, { type: 'appendLog', id: parent.id, actor: 'person', text: `Fanned out ${started.length} subtasks to parallel worktrees: ${started.map(item => item.branch).join(', ')}` })
        return { started }
      }
      case 'board:worktree:status': {
        const project = this.projectFrom(args.repo), primary = project.folders[0]?.path
        const tasks = (this.boardStore.load(this.board(project.id)).notes).filter(note => note.worktree)
        return Object.fromEntries(tasks.map(note => { try { return [note.id, primary ? worktreeStatus(primary, note.worktree!) : null] } catch { return [note.id, null] } }))
      }
      case 'board:worktree:remove': {
        const project = this.projectFrom(args.repo), repo = this.board(project.id)
        const task = this.boardStore.query(repo, { type: 'read', id: String(args.taskId) }) as BoardNote | null
        if (!task?.worktree) throw new Error('This task has no worktree.')
        const owner = this.store.state.contexts.find(context => context.terminals.some(terminal => terminal.cwd === task.worktree!.path))
        if (owner) for (const terminal of owner.terminals) if (this.terminals.running(terminal.id)) await this.terminals.stop(terminal.id)
        removeWorktree(this.primaryFolder(project), task.worktree, args.force === true)
        return this.boardStore.apply(repo, { type: 'appendLog', id: task.id, actor: 'person', text: `Removed worktree ${task.worktree.path}; branch ${task.worktree.branch} is kept.` })
      }
      case 'board:dispatch': {
        // Hand a Task to one agent terminal: assign it to that terminal's
        // Session, mark it working, start the agent if needed, and type the
        // briefing in once the agent is idle.
        const repo = this.board(args.repo)
        const resource = this.store.resource(String(args.terminalId))
        if (resource.terminalKind === 'shell') throw new Error('Choose an agent terminal. A shell cannot receive a briefing.')
        const task = this.boardStore.query(repo, { type: 'read', id: String(args.taskId) }) as BoardNote | null
        if (!task || task.kind !== 'task') throw new Error('Task no longer exists.')
        if (task.status === 'done') throw new Error('This Task is already done.')
        const note = this.boardStore.apply(repo, { type: 'updateNote', id: task.id, expectedRevision: task.revision, patch: { sessionId: resource.contextId, agent: this.agentName(resource), status: task.question ? task.status : 'working', updatedBy: 'person' } }) as BoardNote
        if (!this.terminals.running(resource.id)) await this.invoke('terminalOpen', { id: resource.id })
        const delivery = await this.deliver(resource.id, this.taskBriefing(repo, task.id))
        return { note, delivery }
      }
      case 'terminal:deliver': {
        const resource = this.store.resource(String(args.id))
        if (resource.terminalKind === 'shell') throw new Error('Choose an agent terminal, or copy the text into a shell.')
        return await this.deliver(resource.id, String(args.text ?? ''))
      }
      case 'board:handoff': return this.boardBriefing(this.board(args.repo), String(args.sessionId))
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
      default: throw new Error(`Unknown action: ${action}`)
    }
  }
  /** Attachment ids are a uuid plus the original extension, so the saved
   *  path reads as an image or document to agent CLIs that receive it. */
  private attachmentPath(id: unknown) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}(\.[a-z0-9]{1,10})?$/.test(id)) throw new Error('Invalid attachment.')
    return join(this.store.directory, 'attachments', id)
  }
  saveAttachment(args: Record<string, any>): Attachment {
    if (typeof args.base64 !== 'string' || args.base64.length > 28_000_000) throw new Error('Attachments must be smaller than 20 MB.')
    const data = Buffer.from(args.base64, 'base64')
    if (!data.length || data.length > 20 * 1024 * 1024) throw new Error('This attachment is empty or larger than 20 MB.')
    const name = basename(String(args.name || 'attachment'))
    const mime = String(args.mime || 'application/octet-stream')
    const extension = (extname(name).toLowerCase().match(/^\.[a-z0-9]{1,10}$/)?.[0]) ?? MIME_EXTENSIONS[mime] ?? ''
    const id = `${uuid()}${extension}`
    mkdirSync(join(this.store.directory, 'attachments'), { recursive: true })
    writeFileSync(this.attachmentPath(id), data, { mode: 0o600 })
    return { id, name, mime, size: data.length, path: this.attachmentPath(id), ...(/^image\/(png|jpeg|webp|gif)$/.test(mime) ? { preview: `data:${mime};base64,${args.base64}` } : {}) }
  }
  close() { clearTimeout(this.flushTimer); clearTimeout(this.draftTimer); this.ticketStore.close(); this.boardStore.close(); this.dictation.close(); this.flush(); this.terminals.close(); this.events.close() }
}
