import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Workspace, Session, RepoContext, TerminalKind, TerminalResource } from '../src/types'

export const emptyDraft = () => ({ html: '', text: '', attachments: [] })
const emptyLaunch = () => ({ model: '', reasoningEffort: '' as const, approvalMode: 'on-request' as const, permissionProfile: '', trustWorkspace: false, yolo: false })
export function newRecord(id: string, repo: string, index: number): Session {
  return { id, repo, title: 'New conversation', updatedAt: new Date().toISOString(), model: '', status: 'idle',
    position: { x: (index % 3) * 620, y: Math.floor(index / 3) * 690 }, width: 560, height: 620,
    draft: emptyDraft(), effort: '', items: [], approvals: [], questions: [] }
}

const terminalKind = (raw: unknown): TerminalKind => ['muse', 'codex', 'claude', 'cursor', 'shell', 'custom'].includes(String(raw)) ? raw as TerminalKind : 'muse'
const resourceFromLegacy = (record: Record<string, any>, contextId: string): TerminalResource => {
  const kind = terminalKind(record.terminalKind)
  const now = new Date().toISOString()
  const id = typeof record.id === 'string' ? record.id : `terminal-${contextId}`
  return {
    id, contextId, repo: String(record.repo ?? ''), name: kind === 'shell' ? 'Shell' : kind === 'custom' ? 'Agent' : 'Muse',
    agent: kind === 'shell' ? 'Shell' : kind === 'custom' ? 'Agent' : 'Muse', terminalKind: kind,
    launch: record.launch ?? emptyLaunch(), draft: record.draft ?? emptyDraft(), terminalRunning: false,
    createdAt: String(record.createdAt ?? now), updatedAt: String(record.updatedAt ?? now),
  }
}

export function newContext(id: string, repo: string, name: string, terminal?: TerminalResource): RepoContext {
  const now = new Date().toISOString()
  const first = terminal ?? resourceFromLegacy({ id: `res-${id}`, repo, terminalKind: 'muse' }, id)
  const terminals = [{ ...first, contextId: id, repo }]
  return { id, repo, name, terminals, terminalKind: first.terminalKind, launch: first.launch ?? emptyLaunch(), draft: first.draft, terminalRunning: !!first.terminalRunning, createdAt: now, updatedAt: now }
}

function contextRecord(id: string, repo: string, name: string, terminals: TerminalResource[], createdAt: string, updatedAt: string): RepoContext {
  const first = terminals[0] ?? resourceFromLegacy({ id: `res-${id}`, repo, terminalKind: 'muse' }, id)
  return { id, repo, name, terminals: terminals.length ? terminals : [first], terminalKind: first.terminalKind, launch: first.launch ?? emptyLaunch(), draft: first.draft, terminalRunning: !!first.terminalRunning, createdAt, updatedAt }
}

/** A v1 placeholder row for a Muse session that was imported but never given
 *  a readable name. These rows carry no user intent, so migration drops them. */
const isPlaceholder = (s: Session) =>
  /^\s*Session\s*[·•-]/.test(s.title) && !s.draft.text.trim() && !s.draft.attachments.length
const contextName = (s: Session) => s.title.trim().slice(0, 60) || 'Context'

/** v1 session rows become one context with one default terminal resource. */
export function migrateSessions(sessions: Session[]): RepoContext[] {
  const contexts: RepoContext[] = []
  for (const s of sessions) {
    if (s.archived || isPlaceholder(s)) continue
    const terminal = resourceFromLegacy({ ...s, id: s.id, repo: s.repo, terminalKind: s.terminalKind, launch: s.launch, draft: s.draft, createdAt: s.updatedAt, updatedAt: s.updatedAt }, s.id)
    contexts.push(contextRecord(s.id, s.repo, contextName(s), [terminal], s.updatedAt, s.updatedAt))
  }
  return contexts
}

function normalizeContext(raw: any): RepoContext {
  const id = String(raw?.id ?? '')
  const repo = String(raw?.repo ?? '')
  const now = new Date().toISOString()
  if (!id || !repo) throw new Error('Unsupported Agent Hub workspace file. Your saved file has been preserved.')
  if (!Array.isArray(raw.terminals)) {
    const terminal = resourceFromLegacy({ ...raw, repo }, id)
    return contextRecord(id, repo, String(raw.name ?? 'Context'), [terminal], String(raw.createdAt ?? now), String(raw.updatedAt ?? now))
  }
  const terminals: TerminalResource[] = raw.terminals.map((value: any) => {
    const item = resourceFromLegacy({ ...value, repo }, id)
    item.name = typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 60) : item.name
    item.agent = typeof value.agent === 'string' && value.agent.trim() ? value.agent.trim().slice(0, 80) : item.agent
    if (value.profile && typeof value.profile === 'object' && typeof value.profile.executable === 'string' && Array.isArray(value.profile.args)) {
      item.profile = { label: String(value.profile.label ?? item.agent).slice(0, 80), executable: value.profile.executable.slice(0, 300), args: value.profile.args.filter((arg: unknown) => typeof arg === 'string').slice(0, 40).map((arg: string) => arg.slice(0, 500)) }
    }
    item.terminalKind = terminalKind(value.terminalKind)
    item.terminalRunning = false
    return item
  })
  return contextRecord(id, repo, String(raw.name ?? 'Context'), terminals, String(raw.createdAt ?? now), String(raw.updatedAt ?? now))
}

export const persistedResource = (resource: TerminalResource): TerminalResource => ({ ...resource, terminalRunning: false })
export const persistedContext = (context: RepoContext): RepoContext => {
  const terminals = context.terminals.map(persistedResource)
  return { ...contextRecord(context.id, context.repo, context.name, terminals, context.createdAt, context.updatedAt), terminalRunning: false }
}
export const persistedWorkspace = (state: Workspace): Workspace => ({ ...state, sessions: undefined, contexts: state.contexts.map(persistedContext) })
/** Wire state includes live terminal-running flags; disk state always resets them. */
export const liveResource = (resource: TerminalResource): TerminalResource => ({ ...resource })
export const liveContext = (context: RepoContext): RepoContext => contextRecord(context.id, context.repo, context.name, context.terminals.map(liveResource), context.createdAt, context.updatedAt)
export const liveWorkspace = (state: Workspace): Workspace => ({ ...state, sessions: undefined, contexts: state.contexts.map(liveContext) })

export class Store {
  state: Workspace
  constructor(public directory: string, initialRepo = process.cwd()) {
    mkdirSync(directory, { recursive: true })
    const file = join(directory, 'workspace.json')
    this.state = { version: 2, repos: [initialRepo], contexts: [], selectedRepo: initialRepo, selectedContexts: {}, viewports: {}, theme: 'dark' }
    if (!existsSync(file)) return
    // A corrupt store must surface an error instead of silently overwriting saved work.
    const data = JSON.parse(readFileSync(file, 'utf8')) as Omit<Workspace, 'version'> & { version: number; sessions?: Session[]; dismissedMuseIds?: unknown }
    if (![1, 2, 3].includes(data.version) || !Array.isArray(data.repos)) throw new Error('Unsupported Agent Hub workspace file. Your saved file has been preserved.')
    if (data.version === 1) {
      if (!Array.isArray(data.sessions)) throw new Error('Unsupported Agent Hub workspace file. Your saved file has been preserved.')
      this.state = {
        version: 2, repos: data.repos, contexts: migrateSessions(data.sessions),
        selectedRepo: data.selectedRepo, selectedContexts: {},
        viewports: data.viewports ?? {}, theme: data.theme ?? 'dark',
        ...(data.themeBackground ? { themeBackground: data.themeBackground } : {}),
        ...(data.themeAccent ? { themeAccent: data.themeAccent } : {}),
      }
    } else {
      if (!Array.isArray(data.contexts)) throw new Error('Unsupported Agent Hub workspace file. Your saved file has been preserved.')
      this.state = {
        ...(data as Workspace), version: 2,
        contexts: data.contexts.map(normalizeContext),
        selectedContexts: data.selectedContexts ?? {}, viewports: data.viewports ?? {},
      }
      for (const context of this.state.contexts) for (const resource of context.terminals) resource.terminalRunning = false
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
