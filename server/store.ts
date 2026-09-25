import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { basename, isAbsolute, join, normalize } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Workspace, Project, ProjectFolder, RepoContext, TerminalKind, TerminalResource } from '../src/types'

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

export function newContext(id: string, projectId: string, repo: string, name: string, terminal: TerminalResource): RepoContext {
  const now = new Date().toISOString()
  return { id, projectId, repo, name, terminals: [{ ...terminal, contextId: id, repo }], createdAt: now, updatedAt: now }
}

function normalizeContext(raw: any): RepoContext {
  const id = String(raw?.id ?? '')
  const repo = String(raw?.repo ?? '')
  const now = new Date().toISOString()
  if (!id || !repo) throw new Error('Unsupported Agent Hub workspace file. Your saved file has been preserved.')
  const stored: any[] = Array.isArray(raw.terminals) && raw.terminals.length ? raw.terminals : [{ id: `res-${id}`, terminalKind: 'shell' }]
  return { id, projectId: typeof raw.projectId === 'string' ? raw.projectId : '', repo, name: String(raw.name ?? 'Session').slice(0, 60), terminals: stored.map(value => normalizeResource(value, id, repo)), createdAt: String(raw.createdAt ?? now), updatedAt: String(raw.updatedAt ?? now) }
}

export const PROJECT_COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff', '#f7768e', '#73daca', '#ff9e64']
/** Where a project's board lives: Agent Hub's data directory, not a repo. */
export const projectBoardRoot = (directory: string, id: string) => join(directory, 'projects', id)
const projectId = /^prj-[\w-]{1,80}$/

/** Validate a project's folders: absolute, normalized, unique, primary first. */
export function projectFolders(raw: unknown): ProjectFolder[] {
  const seen = new Set<string>()
  const folders: ProjectFolder[] = []
  for (const item of Array.isArray(raw) ? raw.slice(0, 32) : []) {
    const value = typeof item === 'string' ? { path: item } : item as Record<string, unknown>
    if (!value || typeof value.path !== 'string' || !isAbsolute(value.path)) continue
    const path = normalize(value.path).replace(/(.)\/+$/, '$1')
    if (seen.has(path)) continue
    seen.add(path)
    const label = typeof value.label === 'string' ? value.label.trim().slice(0, 60) : ''
    const note = typeof value.note === 'string' ? value.note.trim().slice(0, 500) : ''
    folders.push({ path, ...(label ? { label } : {}), ...(note ? { note } : {}) })
  }
  return folders
}

export function newProject(directory: string, input: { name?: unknown; description?: unknown; color?: unknown; folders?: unknown; importFrom?: string }, index = 0): Project {
  const folders = projectFolders(input.folders)
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 80) : folders[0] ? basename(folders[0].path) : 'Untitled project'
  const id = `prj-${randomUUID()}`
  const now = new Date().toISOString()
  const color = typeof input.color === 'string' && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color.toLowerCase() : PROJECT_COLORS[index % PROJECT_COLORS.length]
  return { id, name, description: typeof input.description === 'string' ? input.description.trim().slice(0, 2000) : '', color, folders, boardRoot: projectBoardRoot(directory, id), ...(input.importFrom ? { importFrom: input.importFrom } : {}), createdAt: now, updatedAt: now }
}

function normalizeProject(raw: any, directory: string): Project | null {
  if (!raw || typeof raw.id !== 'string' || !projectId.test(raw.id)) return null
  const project = newProject(directory, raw)
  return { ...project, id: raw.id, boardRoot: projectBoardRoot(directory, raw.id), color: typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : project.color,
    ...(typeof raw.importFrom === 'string' && isAbsolute(raw.importFrom) ? { importFrom: raw.importFrom } : {}),
    createdAt: String(raw.createdAt ?? project.createdAt), updatedAt: String(raw.updatedAt ?? project.updatedAt) }
}

/** Before projects, Sessions and boards belonged to a folder. Each folder
 *  with Sessions or a repository board becomes a one-folder project, and
 *  its board is copied in on first use. */
function migrateToProjects(state: Workspace, directory: string) {
  const byFolder = new Map<string, Project>()
  for (const project of state.projects) if (project.folders[0]) byFolder.set(project.folders[0].path, project)
  const ensure = (folder: string) => {
    let project = byFolder.get(folder)
    if (!project) {
      project = newProject(directory, { folders: [folder], importFrom: existsSync(join(folder, '.agents-hub', 'notes')) ? folder : undefined }, state.projects.length)
      state.projects.push(project); byFolder.set(folder, project)
    }
    return project
  }
  for (const context of state.contexts) if (!state.projects.some(project => project.id === context.projectId)) context.projectId = ensure(context.repo).id
  for (const folder of state.repos) if (existsSync(join(folder, '.agents-hub', 'notes'))) ensure(folder)
  const selected: Record<string, string> = {}
  for (const [key, value] of Object.entries(state.selectedContexts ?? {})) selected[key.startsWith('prj-') ? key : byFolder.get(key)?.id ?? key] = value
  state.selectedContexts = selected
  if (!state.projects.some(project => project.id === state.selectedProject)) state.selectedProject = byFolder.get(state.selectedRepo)?.id ?? state.projects[0]?.id
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
    this.state = { version: 2, projects: [], repos: [initialRepo], contexts: [], selectedRepo: initialRepo, selectedContexts: {}, viewports: {}, theme: 'dark' }
    if (!existsSync(file)) return
    // A corrupt store must surface an error instead of silently overwriting saved work.
    const data = JSON.parse(readFileSync(file, 'utf8')) as Omit<Workspace, 'version'> & { version: number }
    if (![2, 3].includes(data.version) || !Array.isArray(data.repos) || !Array.isArray(data.contexts)) throw new Error('Unsupported Agent Hub workspace file. Your saved file has been preserved.')
    const { themeBackground, themeAccent } = data
    this.state = {
      version: 2, projects: (Array.isArray(data.projects) ? data.projects : []).map(item => normalizeProject(item, directory)).filter((item): item is Project => !!item),
      ...(typeof data.selectedProject === 'string' ? { selectedProject: data.selectedProject } : {}),
      repos: data.repos, contexts: data.contexts.map(normalizeContext),
      selectedRepo: data.selectedRepo, selectedContexts: data.selectedContexts ?? {},
      viewports: data.viewports ?? {}, theme: data.theme ?? 'dark',
      ...(themeBackground ? { themeBackground } : {}), ...(themeAccent ? { themeAccent } : {}),
    }
    if (initialRepo !== '/' && data.repos[0] === '/' && !this.state.contexts.some(c => c.repo === '/')) {
      this.state.repos = this.state.repos.filter(r => r !== '/')
      if (this.state.selectedRepo === '/') this.state.selectedRepo = this.state.repos[0] || initialRepo
    }
    if (!this.state.repos.includes(this.state.selectedRepo) && this.state.repos.length) this.state.selectedRepo = this.state.repos[0]
    migrateToProjects(this.state, directory)
  }
  save() {
    const target = join(this.directory, 'workspace.json')
    writeFileSync(target + '.tmp', JSON.stringify(persistedWorkspace(this.state)), { mode: 0o600 })
    renameSync(target + '.tmp', target)
  }
  project(id: string) {
    const project = this.state.projects.find(item => item.id === id)
    if (!project) throw new Error('This project is no longer available.')
    return project
  }
  /** The project a board root belongs to. */
  projectForBoard(root: string) { return this.state.projects.find(project => project.boardRoot === normalize(root).replace(/\/+$/, '')) }
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
