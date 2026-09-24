import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Workspace, RepoContext, TerminalKind, TerminalResource } from '../src/types'

export const emptyDraft = () => ({ html: '', text: '', attachments: [] })
const KINDS: TerminalKind[] = ['codex', 'claude', 'cursor', 'shell', 'custom']
const DEFAULT_NAMES: Record<TerminalKind, string> = { codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor Agent', shell: 'Shell', custom: 'Agent' }

function normalizeProfile(raw: any, fallbackLabel: string) {
  if (!raw || typeof raw !== 'object' || typeof raw.executable !== 'string' || !Array.isArray(raw.args)) return undefined
  return { label: String(raw.label ?? fallbackLabel).slice(0, 80), executable: raw.executable.slice(0, 300), args: raw.args.filter((arg: unknown) => typeof arg === 'string').slice(0, 40).map((arg: string) => arg.slice(0, 500)) }
}

/** Stored terminal → resource. A kind this version no longer supports keeps
 *  its saved command as a custom profile, or opens as a shell without one. */
function normalizeResource(raw: any, contextId: string, repo: string): TerminalResource {
  const now = new Date().toISOString()
  const storedKind = String(raw?.terminalKind)
  const profile = normalizeProfile(raw?.profile, typeof raw?.agent === 'string' ? raw.agent : 'Agent')
  const kind: TerminalKind = (KINDS as string[]).includes(storedKind) ? storedKind as TerminalKind : profile ? 'custom' : 'shell'
  const text = (value: unknown, max: number) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : ''
  const agent = text(raw?.agent, 80) || profile?.label || DEFAULT_NAMES[kind]
  return {
    id: typeof raw?.id === 'string' ? raw.id : `terminal-${contextId}`, contextId, repo,
    name: text(raw?.name, 60) || agent, agent, terminalKind: kind, ...(profile && kind !== 'shell' ? { profile } : {}),
    draft: raw?.draft && typeof raw.draft === 'object' && Array.isArray(raw.draft.attachments) ? raw.draft : emptyDraft(),
    ...(typeof raw?.cwd === 'string' && raw.cwd.startsWith('/') ? { cwd: raw.cwd.slice(0, 1000) } : {}),
    ...(typeof raw?.conversationId === 'string' && /^[\w-]{1,200}$/.test(raw.conversationId) && kind !== 'shell' ? { conversationId: raw.conversationId } : {}),
    terminalRunning: false, createdAt: String(raw?.createdAt ?? now), updatedAt: String(raw?.updatedAt ?? now),
  }
}

export function newContext(id: string, repo: string, name: string, terminal: TerminalResource): RepoContext {
  const now = new Date().toISOString()
  return { id, repo, name, terminals: [{ ...terminal, contextId: id, repo }], createdAt: now, updatedAt: now }
}

function normalizeContext(raw: any): RepoContext {
  const id = String(raw?.id ?? '')
  const repo = String(raw?.repo ?? '')
  const now = new Date().toISOString()
  if (!id || !repo) throw new Error('Unsupported Agent Hub workspace file. Your saved file has been preserved.')
  const stored: any[] = Array.isArray(raw.terminals) && raw.terminals.length ? raw.terminals : [{ id: `res-${id}`, terminalKind: 'shell' }]
  return { id, repo, name: String(raw.name ?? 'Session').slice(0, 60), terminals: stored.map(value => normalizeResource(value, id, repo)), createdAt: String(raw.createdAt ?? now), updatedAt: String(raw.updatedAt ?? now) }
}

export const persistedResource = ({ activity: _live, ...resource }: TerminalResource): TerminalResource => ({ ...resource, terminalRunning: false })
export const persistedContext = (context: RepoContext): RepoContext => ({ ...context, terminals: context.terminals.map(persistedResource) })
export const persistedWorkspace = (state: Workspace): Workspace => ({ ...state, contexts: state.contexts.map(persistedContext) })
/** Wire state includes live terminal-running flags; disk state always resets them. */
export const liveResource = (resource: TerminalResource): TerminalResource => ({ ...resource })
export const liveContext = (context: RepoContext): RepoContext => ({ ...context, terminals: context.terminals.map(liveResource) })
export const liveWorkspace = (state: Workspace): Workspace => ({ ...state, contexts: state.contexts.map(liveContext) })

export class Store {
  state: Workspace
  constructor(public directory: string, initialRepo = process.cwd()) {
    mkdirSync(directory, { recursive: true })
    const file = join(directory, 'workspace.json')
    this.state = { version: 2, repos: [initialRepo], contexts: [], selectedRepo: initialRepo, selectedContexts: {}, viewports: {}, theme: 'dark' }
    if (!existsSync(file)) return
    // A corrupt store must surface an error instead of silently overwriting saved work.
    const data = JSON.parse(readFileSync(file, 'utf8')) as Omit<Workspace, 'version'> & { version: number }
    if (![2, 3].includes(data.version) || !Array.isArray(data.repos) || !Array.isArray(data.contexts)) throw new Error('Unsupported Agent Hub workspace file. Your saved file has been preserved.')
    const { themeBackground, themeAccent } = data
    this.state = {
      version: 2, repos: data.repos, contexts: data.contexts.map(normalizeContext),
      selectedRepo: data.selectedRepo, selectedContexts: data.selectedContexts ?? {},
      viewports: data.viewports ?? {}, theme: data.theme ?? 'dark',
      ...(themeBackground ? { themeBackground } : {}), ...(themeAccent ? { themeAccent } : {}),
    }
    if (initialRepo !== '/' && data.repos[0] === '/' && !this.state.contexts.some(c => c.repo === '/')) {
      this.state.repos = this.state.repos.filter(r => r !== '/')
      if (this.state.selectedRepo === '/') this.state.selectedRepo = this.state.repos[0] || initialRepo
    }
    if (!this.state.repos.includes(this.state.selectedRepo) && this.state.repos.length) this.state.selectedRepo = this.state.repos[0]
  }
  save() {
    const target = join(this.directory, 'workspace.json')
    writeFileSync(target + '.tmp', JSON.stringify(persistedWorkspace(this.state)), { mode: 0o600 })
    renameSync(target + '.tmp', target)
  }
  context(id: string) {
    const context = this.state.contexts.find(c => c.id === id)
    if (!context) throw new Error('This context is no longer available.')
    return context
  }
  resource(id: string) {
    for (const context of this.state.contexts) {
      const resource = context.terminals.find(t => t.id === id)
      if (resource) return resource
    }
    const legacyContext = this.state.contexts.find(context => context.id === id)
    if (legacyContext?.terminals[0]) return legacyContext.terminals[0]
    throw new Error('This terminal is no longer available.')
  }
}
