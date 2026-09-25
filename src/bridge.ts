import type { Bridge, Workspace, Bootstrap, Project, RepoContext, TerminalResource, TerminalKind, Ticket } from './types'
import { normalizeThemeColor } from './theme'
import { previewBoard } from './preview-board'
import { preferredOrganizerModel, type OrganizerConfig } from '../shared/organizer-models'

// Browser-only preview. The desktop always uses the isolated Electron preload bridge.
function previewBridge(): Bridge {
  const board = previewBoard()
  const workspaceKey = 'agent-hub-preview-v8'
  const ticketKey = 'agent-hub-tickets-v2'
  const empty = { html: '', text: '', attachments: [] }
  const repo = '/Projects/agent-hub'
  const now = new Date().toISOString()
  const resource = (id: string, contextId: string, root: string, name: string, agent = 'Shell', terminalKind: TerminalKind = 'shell'): TerminalResource => ({ id, contextId, repo: root, name, agent, terminalKind, ...(terminalKind === 'custom' ? { profile: { label: agent, executable: agent.toLowerCase().includes('claude') ? 'claude' : 'codex', args: [] } } : {}), draft: { ...empty }, createdAt: now, updatedAt: now })
  // Preview projects use a folder path as their board root, so the sample
  // board below stays attached to the first project.
  const project = (id: string, name: string, color: string, folders: string[], description = ''): Project => ({ id, name, description, color, folders: folders.map((path, index) => ({ path, ...(index ? { label: path.split('/').at(-1) } : {}) })), boardRoot: folders[0], createdAt: now, updatedAt: now })
  const group = (id: string, projectId: string, name: string, root: string, terminals: TerminalResource[], createdAt = now, updatedAt = now): RepoContext => ({ id, projectId, repo: root, name, terminals, createdAt, updatedAt })
  const initial: Workspace = { version: 2, repos: [repo, '/Projects/website'], selectedRepo: repo, selectedProject: 'prj-preview-hub', selectedContexts: { 'prj-preview-hub': 'preview-1' }, theme: 'dark', viewports: {},
    projects: [project('prj-preview-hub', 'Agent Hub', '#9ece6a', [repo, '/Projects/website'], 'The desktop app and its marketing site'), project('prj-preview-sketch', 'Sketches', '#bb9af7', ['/Projects/sketches'])],
    contexts: [
      group('preview-1', 'prj-preview-hub', 'frontend', repo, [resource('preview-1-codex', 'preview-1', repo, 'Codex', 'Codex', 'custom'), resource('preview-1-shell', 'preview-1', repo, 'Shell', 'Shell', 'shell')]),
      group('preview-2', 'prj-preview-hub', 'backend', repo, [resource('preview-2-claude', 'preview-2', repo, 'Claude Code', 'Claude Code', 'custom')]),
      group('preview-3', 'prj-preview-sketch', 'research', '/Projects/sketches', [resource('preview-3-terminal', 'preview-3', '/Projects/sketches', 'Shell', 'Shell', 'shell')]),
    ] }
  // One sample agent mid-task, so the canvas shows live status in the preview.
  Object.assign(initial.contexts[0].terminals[0], { terminalRunning: true, activity: { state: 'working', detail: 'Editing board-store.ts', since: now, source: 'hooks' } })
  let state: Workspace = JSON.parse(localStorage.getItem(workspaceKey) || 'null') || initial
  if (state.version !== 2 || !Array.isArray(state.contexts) || !Array.isArray(state.projects)) state = initial
  const nowPast = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const sampleTickets: Ticket[] = [
    { id: 'AH-A17C42D0', title: 'Clarify ticket handoff for agents', status: 'backlog', priority: 'normal', description: 'Make the workspace ticket files easy to find and understand from any agent terminal.', acceptance: ['Tickets explain their status and writable fields'], agent: '', contextId: '', contextName: '', createdAt: nowPast(180), updatedAt: nowPast(180) },
    { id: 'AH-5D2B8F31', title: 'Group terminals by area of work', status: 'planning', priority: 'high', description: 'Keep related agents together inside named contexts.', acceptance: ['A context can contain multiple independently running terminals'], agent: 'Codex', contextId: 'preview-1', contextName: 'frontend', createdAt: nowPast(150), updatedAt: nowPast(150) },
    { id: 'AH-8F11C603', title: 'Persist tickets beside the workspace', status: 'ready', priority: 'high', description: 'Store one readable file per ticket so any local agent can access it.', acceptance: ['External status edits appear on the board'], agent: 'Claude Code', contextId: 'preview-2', contextName: 'backend', createdAt: nowPast(120), updatedAt: nowPast(120) },
    { id: 'AH-70C39A4E', title: 'Launch a custom agent profile', status: 'in_progress', priority: 'urgent', description: 'Run any executable with a separately configured argument list.', acceptance: ['Command and arguments are entered separately'], agent: 'Codex', contextId: 'preview-1', contextName: 'frontend', createdAt: nowPast(80), updatedAt: nowPast(18) },
    { id: 'AH-274A13BE', title: 'Check the compact board layout', status: 'needs_testing', priority: 'normal', description: 'Keep every workflow lane reachable in a narrow window.', acceptance: ['The board scrolls horizontally without squeezing ticket titles'], agent: 'Gemini CLI', contextId: '', contextName: '', createdAt: nowPast(55), updatedAt: nowPast(5) },
    { id: 'AH-B320D9A5', title: 'Document ticket status handoff', status: 'blocked', priority: 'low', description: 'Add agent-facing instructions next to ticket files.', acceptance: [], agent: '', contextId: '', contextName: '', createdAt: nowPast(30), updatedAt: nowPast(30) },
    { id: 'AH-92D4EE7A', title: 'Keep provider options independent', status: 'completed', priority: 'normal', description: 'Retain existing integrations alongside generic CLI agents.', acceptance: ['More than one terminal profile can be used in a context'], agent: 'Codex', contextId: 'preview-1', contextName: 'frontend', createdAt: nowPast(20), updatedAt: nowPast(2) },
  ]
  let ticketsByRepo: Record<string, Ticket[]> = JSON.parse(localStorage.getItem(ticketKey) || 'null') || { [repo]: sampleTickets }
  const listeners = new Set<(s: Workspace) => void>()
  const ticketListeners = new Set<(snapshot: { repo: string; tickets: Ticket[] }) => void>()
  const emit = () => { localStorage.setItem(workspaceKey, JSON.stringify(state)); listeners.forEach(l => l(structuredClone(state))) }
  const emitTickets = (root: string) => {
    localStorage.setItem(ticketKey, JSON.stringify(ticketsByRepo))
    ticketListeners.forEach(l => l({ repo: root, tickets: structuredClone(ticketsByRepo[root] ?? []) }))
  }
  const findTerminal = (id: string) => state.contexts.flatMap(c => c.terminals).find(t => t.id === id)
  const makeTerminal = (id: string, contextId: string, root: string, args: Record<string, any>) => {
    const kind = ['codex', 'claude', 'cursor', 'shell', 'custom'].includes(args.terminalKind) ? args.terminalKind as TerminalKind : 'shell'
    const agent = ({ codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor Agent', shell: 'Shell', custom: String(args.profile?.label || 'Agent') } as Record<TerminalKind, string>)[kind]
    const terminalName = String(args.terminalName || agent).trim().slice(0, 60) || agent
    const result = resource(id, contextId, root, terminalName, agent, kind)
    if (kind === 'custom') result.profile = args.profile && typeof args.profile === 'object' ? args.profile : { label: agent, executable: String(args.executable || 'codex'), args: Array.isArray(args.args) ? args.args.filter((v: unknown) => typeof v === 'string') : [] }
    if (['codex', 'claude', 'cursor'].includes(kind)) result.profile = { label: agent, executable: ({ codex: 'codex', claude: 'claude', cursor: 'cursor-agent' } as Record<string, string>)[kind], args: args.providerModel ? ['--model', String(args.providerModel)] : [] }
    return result
  }
  return {
    desktop: false,
    subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn) } },
    onTickets: fn => { ticketListeners.add(fn); return () => { ticketListeners.delete(fn) } },
    onBoard: fn => board.subscribe(fn),
    async invoke<T>(action: string, args: Record<string, any> = {}) {
      const activeContext = state.contexts.find(c => c.id === args.id || c.id === args.contextId)
      let result: any = null
      switch (action) {
        case 'bootstrap': return { workspace: structuredClone(state) } as T
        case 'terminalProviders': return [{ kind: 'codex', label: 'Codex', executable: '/usr/local/bin/codex' }, { kind: 'claude', label: 'Claude Code', executable: '/usr/local/bin/claude' }, { kind: 'cursor', label: 'Cursor Agent', executable: '/usr/local/bin/cursor-agent' }] as T
        case 'listDir': {
          const home = '/Projects'
          const dir = typeof args.path === 'string' && args.path ? args.path : home
          const fakeFs: Record<string, string[]> = {
            '/Projects': ['agent-hub', 'sketches', 'website'], '/Projects/agent-hub': ['docs', 'server', 'src'],
            '/Projects/agent-hub/src': ['components'], '/Projects/agent-hub/src/components': [], '/Projects/agent-hub/server': [],
            '/Projects/agent-hub/docs': [], '/Projects/website': ['pages', 'public'], '/Projects/website/pages': [],
            '/Projects/website/public': [], '/Projects/sketches': [],
          }
          if (!(dir in fakeFs)) throw new Error(`Cannot read ${dir}.`)
          return { path: dir, home, entries: fakeFs[dir].map(name => ({ name, path: `${dir}/${name}` })) } as T
        }
        case 'selectRepo': state.selectedRepo = args.repo; break
        case 'selectContext': if (activeContext) { state.selectedProject = activeContext.projectId; (state.selectedContexts ??= {})[activeContext.projectId] = activeContext.id } break
        case 'newContext': {
          const owner = state.projects.find(item => item.id === args.project) ?? state.projects[0]
          if (!owner) throw new Error('Create a project first.')
          const root = owner.folders[0].path
          const name = String(args.name || `Session ${state.contexts.filter(c => c.projectId === owner.id).length + 1}`).trim().slice(0, 60)
          const id = crypto.randomUUID()
          result = group(id, owner.id, name || 'Session', root, [makeTerminal(crypto.randomUUID(), id, root, args)])
          state.contexts.push(result); state.selectedProject = owner.id; (state.selectedContexts ??= {})[owner.id] = id
          break
        }
        case 'project:create': {
          const folders = (args.folders ?? []).map((item: string | { path: string }) => typeof item === 'string' ? { path: item } : item)
          if (!folders.length) throw new Error('Add at least one folder to the project.')
          result = { ...project(`prj-${crypto.randomUUID()}`, String(args.name || folders[0].path.split('/').at(-1)), String(args.color || '#7aa2f7'), []), description: String(args.description ?? ''), folders, boardRoot: folders[0].path }
          state.projects.push(result); state.selectedProject = result.id
          break
        }
        case 'project:update': {
          const target = state.projects.find(item => item.id === args.id)
          if (!target) throw new Error('This project is no longer available.')
          if (args.patch?.folders && !args.patch.folders.length) throw new Error('A project needs at least one folder.')
          Object.assign(target, args.patch, { updatedAt: new Date().toISOString() })
          result = target; break
        }
        case 'project:select': state.selectedProject = String(args.id); result = structuredClone(state); break
        case 'project:delete': {
          state.contexts = state.contexts.filter(item => item.projectId !== args.id)
          state.projects = state.projects.filter(item => item.id !== args.id)
          if (state.selectedProject === args.id) state.selectedProject = state.projects[0]?.id
          result = structuredClone(state); break
        }
        case 'newTerminal': {
          if (!activeContext) throw new Error('This context is no longer available.')
          result = makeTerminal(crypto.randomUUID(), activeContext.id, activeContext.repo, args); activeContext.terminals.push(result); activeContext.updatedAt = now
          break
        }
        case 'deleteContext': if (activeContext) { state.contexts = state.contexts.filter(c => c.id !== activeContext.id); for (const [key, id] of Object.entries(state.selectedContexts ?? {})) if (id === activeContext.id) { const fallback = state.contexts.find(c => c.projectId === key); if (fallback) state.selectedContexts![key] = fallback.id; else delete state.selectedContexts![key] } } break
        case 'deleteTerminal': {
          const terminal = findTerminal(String(args.id))
          const owner = state.contexts.find(c => c.terminals.some(t => t.id === args.id))
          if (owner && terminal) { if (owner.terminals.length <= 1) throw new Error('A context must keep at least one terminal.'); owner.terminals = owner.terminals.filter(t => t.id !== args.id) }
          break
        }
        case 'patchContext': if (activeContext && typeof args.patch?.name === 'string' && args.patch.name.trim()) activeContext.name = args.patch.name.trim().slice(0, 60); result = activeContext; break
        case 'patchTerminal': {
          const terminal = findTerminal(String(args.id))
          if (terminal) Object.assign(terminal, args.patch)
          if (Object.keys(args.patch ?? {}).every(k => k === 'draft')) { localStorage.setItem(workspaceKey, JSON.stringify(state)); return null as T }
          result = terminal; break
        }
        case 'preferences': {
          if (args.theme) {
            if (state.theme !== args.theme && !('themeBackground' in args)) delete state.themeBackground
            state.theme = args.theme
          }
          for (const key of ['themeBackground', 'themeAccent'] as const) {
            if (!(key in args)) continue
            const raw = args[key]
            if (raw === null || raw === '' || raw === undefined) delete state[key]
            else { const color = normalizeThemeColor(raw); if (color) state[key] = color }
          }
          if (args.viewport) state.viewports[args.repo] = args.viewport
          break
        }
        case 'attachment': return { id: crypto.randomUUID(), name: args.name, mime: args.mime, size: atob(args.base64).length, path: `/tmp/${args.name}`, preview: args.mime.startsWith('image/') ? `data:${args.mime};base64,${args.base64}` : undefined } as T
        case 'attachmentPreview': return null as T
        case 'attachmentPath': return `/tmp/${args.attachmentId}` as T
        case 'terminalOpen': { const terminal = findTerminal(String(args.id)); if (terminal) terminal.terminalRunning = true; break }
        case 'terminalClose': { const terminal = findTerminal(String(args.id)); if (terminal) terminal.terminalRunning = false; break }
        case 'tickets:list': return structuredClone(ticketsByRepo[String(args.repo)] ?? []) as T
        case 'board:load': return board.load(String(args.repo || state.selectedRepo)) as T
        case 'board:query': return board.query(String(args.repo || state.selectedRepo), args.query) as T
        case 'board:apply': return board.apply(String(args.repo || state.selectedRepo), args.command) as T
        case 'board:answer': return { note: board.apply(String(args.repo || state.selectedRepo), { type: 'answerQuestion', id: String(args.id), answer: String(args.answer) }), delivery: 'none' } as T
        case 'terminal:deliver': return 'queued' as T
        case 'board:worktree:status': return {} as T
        case 'board:fanout': case 'board:worktree:remove': throw new Error('Worktrees and agents run in the desktop app.')
        case 'board:freshness': return { 'AH-274A13BE': { stale: true, reasons: ['server/service.ts changed after this was verified'], verifiedAt: now } } as T
        case 'board:dispatch': {
          const root = String(args.repo || state.selectedRepo), terminal = findTerminal(String(args.terminalId))
          if (!terminal) throw new Error('That agent is no longer available.')
          const task = board.query(root, { type: 'read', id: String(args.taskId) }) as import('../shared/board').BoardNote | null
          if (!task) throw new Error('Task no longer exists.')
          const note = board.apply(root, { type: 'updateNote', id: task.id, expectedRevision: task.revision, patch: { sessionId: terminal.contextId, agent: terminal.name, status: task.question ? task.status : 'working' } })
          terminal.terminalRunning = true; terminal.activity = { state: 'working', detail: 'Reading the briefing', since: new Date().toISOString(), source: 'hooks' }
          emit()
          return { note, delivery: 'queued' } as T
        }
        case 'board:image:add': {
          const id = crypto.randomUUID(), mime = String(args.mime)
          const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]
          const image = { id, path: `.agents-hub/assets/${id}.${extension}`, name: String(args.name || 'image'), mime, size: atob(String(args.base64)).length }
          try { localStorage.setItem(`agent-hub-preview-image:${id}`, `data:${mime};base64,${args.base64}`) } catch { throw new Error('Browser preview storage is full. Use the desktop app for larger images.') }
          return image as T
        }
        case 'board:image:preview': return localStorage.getItem(`agent-hub-preview-image:${args.id}`) as T
        case 'board:organizer:get': {
          const stored = JSON.parse(localStorage.getItem(`agent-hub-preview-organizer:${String(args.repo || state.selectedRepo)}`) || '{}') as Partial<OrganizerConfig>
          const provider = stored.provider === 'claude' ? 'claude' : 'codex'
          return { config: { provider, model: stored.model?.trim() || preferredOrganizerModel(provider), enabled: stored.enabled === true }, last: null } as T
        }
        case 'board:organizer:save': { const config = args.config as OrganizerConfig; localStorage.setItem(`agent-hub-preview-organizer:${String(args.repo || state.selectedRepo)}`, JSON.stringify(config)); return config as T }
        case 'board:organizer:run': case 'board:organizer:undo': throw new Error('Canvas organization runs in the desktop app.')
        case 'dictation:start': throw new Error('Dictation is available in the desktop app.')
        case 'dictation:stop': return '' as T
        case 'dictation:cancel': return null as T
        case 'board:briefing': { const task = board.query(String(args.repo || state.selectedRepo), { type: 'read', id: String(args.id) }) as any; return `Work on Task ${task?.id}: ${task?.title}.\n\n${task?.body ?? ''}\n\nRead the shared Tasks canvas and capture a concise codebase learning when finished.` as T }
        case 'board:handoff': { const root = String(args.repo || state.selectedRepo); const snapshot = board.load(root); return `You are working in Agent Hub for ${root}. Read the shared Tasks canvas and .agents-hub/README.md. Notes are Markdown files in .agents-hub/notes; .agents-hub/canvas.json stores their layout. Review relevant Tasks and Codebase Context before coding.\n\nBoard notes: ${snapshot.notes.map(note => `${note.id} ${note.kind}: ${note.title}`).join('; ')}\n\nKeep Task status current and record a concise, evidence-backed Codebase Context learning after each Task.` as T }
        case 'tickets:create': {
          const root = String(args.repo || state.selectedRepo)
          const ticket: Ticket = { ...args.ticket, id: `AH-${crypto.randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
          ticketsByRepo[root] = [...(ticketsByRepo[root] ?? []), ticket]; emitTickets(root); return ticket as T
        }
        case 'tickets:update': {
          const root = String(args.repo || state.selectedRepo)
          let updated: Ticket | undefined
          ticketsByRepo[root] = (ticketsByRepo[root] ?? []).map(ticket => {
            if (ticket.id !== args.id) return ticket
            if (typeof args.expectedUpdatedAt === 'string' && ticket.updatedAt !== args.expectedUpdatedAt) throw new Error('This ticket changed on disk. Close and reopen it before saving your changes.')
            return (updated = { ...ticket, ...args.patch, updatedAt: new Date(Math.max(Date.now(), Date.parse(ticket.updatedAt) + 1 || 0)).toISOString() })
          })
          if (!updated) throw new Error('This ticket is no longer available.')
          emitTickets(root); return updated as T
        }
        case 'clipboard': return [] as T
        case 'newSession': case 'patchSession': case 'read': case 'leaveChat':
          throw new Error('Agent Hub stores workspace tickets, contexts, and terminal resources; provider sessions stay inside their CLI.')
        case 'send': case 'interrupt': case 'setModel': case 'approval': case 'answer': case 'fork':
          throw new Error('Structured chat actions are not available for generic CLI agents.')
        default: throw new Error('This action is available in the Agent Hub desktop app.')
      }
      emit(); return (result ?? structuredClone(state)) as T
    },
  }
}
export const bridge = window.agentHub ?? previewBridge()
