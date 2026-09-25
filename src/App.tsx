import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { BookOpen, Bot, Check, Layers3, Folder, Loader2, Moon, Monitor, PanelLeftClose, PanelLeftOpen, Pencil, Play, Plus, Settings2, Square, Sun, Terminal, Trash2, X } from 'lucide-react'
import { flushTerminalDraft } from './TerminalComposer'
import FolderBrowser, { type MarkedFolder } from './FolderBrowser'
import ProjectsPanel from './ProjectsPanel'
import ProjectModal, { type ProjectInput } from './ProjectModal'
import LaunchModal, { type TerminalLaunchRequest } from './LaunchModal'
import TerminalView, { disposeTerminal } from './TerminalView'
import AgentDrawer, { DRAWER_DEFAULT, DRAWER_MAX, DRAWER_MIN } from './AgentDrawer'
import CommandPalette, { type PaletteAction } from './CommandPalette'
import type { NoteKind } from '../shared/board'
import BoardCanvas from './BoardCanvas'
import { bridge } from './bridge'
import { mostUrgent, STATE_LABELS, terminalState, terminalStatus } from './agentState'
import { applyThemeVars, customThemeVars, DEFAULT_ACCENT, DEFAULT_CANVAS } from './theme'
import type { ThemeMode } from './theme'
import type { Bootstrap, Project, RepoContext, TerminalResource, Workspace } from './types'

const SIDE_MIN = 200, SIDE_MAX = 480, SIDE_DEFAULT = 248
const clampSide = (width: number) => Math.min(SIDE_MAX, Math.max(SIDE_MIN, width))
const folderName = (path: string) => path.split('/').filter(Boolean).at(-1) || path
const byName = (a: RepoContext, b: RepoContext) => a.createdAt.localeCompare(b.createdAt)
type PendingLaunch = { type: 'context'; project: Project } | { type: 'terminal'; context: RepoContext }

function WorkspaceApp() {
  const [data, setData] = useState<Bootstrap | null>(null)
  const [loadingError, setLoadingError] = useState('')
  const [sidebar, setSidebar] = useState(true)
  const [settings, setSettings] = useState(false)
  const [view, setView] = useState<'tasks' | 'terminals'>('tasks')
  const [activeContextId, setActiveContextId] = useState<string | null>(null)
  const [activeTerminals, setActiveTerminals] = useState<Record<string, string>>({})
  const [selectedRepo, setSelectedRepo] = useState('')
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [projectEditor, setProjectEditor] = useState<{ project?: Project; folders?: string[] } | null>(null)
  const [notice, setNotice] = useState('')
  const [briefing, setBriefing] = useState<{ sessionId: string; title: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingLaunch, setPendingLaunch] = useState<PendingLaunch | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameInput, setRenameInput] = useState('')
  const [deleteContextId, setDeleteContextId] = useState<string | null>(null)
  const [deleteTerminalId, setDeleteTerminalId] = useState<string | null>(null)
  const [sideWidth, setSideWidth] = useState(() => {
    try { const saved = Number(localStorage.getItem('agent-hub-sidebar-width')); return Number.isFinite(saved) ? clampSide(saved) : SIDE_DEFAULT }
    catch { return SIDE_DEFAULT }
  })
  const sideDrag = useRef<{ startX: number; startW: number } | null>(null)
  const settingsPanel = useRef<HTMLElement>(null)
  const settingsTrigger = useRef<HTMLButtonElement>(null)
  // The folder selected in the file browser, and the project being worked
  // on. `repo` is the project's board root, which board calls and the canvas
  // key on.
  const browsing = selectedRepo || data?.workspace.selectedRepo || ''
  const projects = data?.workspace.projects ?? []
  const project = projects.find(item => item.id === selectedProjectId) ?? projects.find(item => item.id === data?.workspace.selectedProject) ?? projects[0] ?? null
  const repo = project?.boardRoot ?? ''
  const contexts = data?.workspace.contexts ?? []
  const repoContexts = useMemo(() => contexts.filter(context => context.projectId === project?.id).sort(byName), [contexts, project?.id])
  const activeContext = repoContexts.find(context => context.id === activeContextId) ?? repoContexts.find(context => context.id === data?.workspace.selectedContexts?.[project?.id ?? '']) ?? repoContexts[0] ?? null
  const activeTerminal = activeContext?.terminals.find(terminal => terminal.id === activeTerminals[activeContext.id]) ?? activeContext?.terminals[0] ?? null
  const allTerminals = repoContexts.flatMap(context => context.terminals)
  const agentTerminals = allTerminals.filter(terminal => terminal.terminalKind !== 'shell')
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const lastDrawer = useRef<string | null>(null)
  const [drawerWidth, setDrawerWidth] = useState(() => {
    try { const saved = Number(localStorage.getItem('agent-hub-drawer-width')); return saved ? Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, saved)) : DRAWER_DEFAULT } catch { return DRAWER_DEFAULT }
  })
  const drawerTerminal = allTerminals.find(terminal => terminal.id === drawerId) ?? null
  const openDrawer = (id: string | null) => { if (id) lastDrawer.current = id; setDrawerId(id) }
  const resizeDrawer = (width: number) => { setDrawerWidth(width); try { localStorage.setItem('agent-hub-drawer-width', String(width)) } catch { /* width is a convenience */ } }
  const runningCount = allTerminals.filter(terminal => terminal.terminalRunning).length
  const selectionRequest = useRef(0)

  const notify = (message: string) => setNotice(message)
  useEffect(() => {
    let live = true
    bridge.invoke<Bootstrap>('bootstrap').then(value => {
      if (!live) return
      setData(value); setSelectedRepo(value.workspace.selectedRepo); setSelectedProjectId(value.workspace.selectedProject ?? '')
      setActiveContextId(value.workspace.selectedContexts?.[value.workspace.selectedProject ?? ''] ?? null)
    }).catch(error => { if (live) setLoadingError(error.message) })
    const stopWorkspace = bridge.subscribe(workspace => { if (live) setData(old => old ? { ...old, workspace } : old) })
    const stopResource = bridge.onResource?.(resource => {
      if (!live) return
      setData(old => old ? { ...old, workspace: { ...old.workspace, contexts: old.workspace.contexts.map(context => {
        const terminals = context.terminals.map(item => item.id === resource.id ? resource : item)
        if (terminals.every((item, index) => item === context.terminals[index])) return context
        return { ...context, terminals }
      }) } } : old)
    })
    return () => { live = false; stopWorkspace(); stopResource?.() }
  }, [])

  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)'), update = () => setSystemDark(media.matches)
    media.addEventListener('change', update); return () => media.removeEventListener('change', update)
  }, [])
  const themeName = data?.workspace.theme ?? 'dark'
  const themeMode: ThemeMode = themeName === 'system' ? (systemDark ? 'dark' : 'light') : themeName
  const customBg = data?.workspace.themeBackground, customAccent = data?.workspace.themeAccent
  useEffect(() => {
    document.documentElement.dataset.theme = themeMode
    applyThemeVars(document.documentElement.style, customThemeVars({ background: customBg, accent: customAccent, mode: themeMode }))
  }, [themeMode, customBg, customAccent])

  const selectProject = async (id: string) => {
    const request = ++selectionRequest.current
    if (activeTerminal) await flushTerminalDraft(activeTerminal.id)
    if (request !== selectionRequest.current) return
    setSelectedProjectId(id); setRenaming(false); setDeleteContextId(null)
    try {
      const workspace = await bridge.invoke<Workspace>('project:select', { id })
      if (request !== selectionRequest.current) return
      setData(old => old ? { ...old, workspace } : old)
      setActiveContextId(workspace.selectedContexts?.[id] ?? null)
    } catch (cause) { notify((cause as Error).message) }
  }
  // Browsing a folder never changes the project, unless the folder belongs
  // to another project, which then becomes current.
  const selectRepo = async (path: string) => {
    setSelectedRepo(path)
    try {
      const workspace = await bridge.invoke<Workspace>('selectRepo', { repo: path })
      setData(old => old ? { ...old, workspace } : old)
    } catch (cause) { notify((cause as Error).message) }
    const owner = projects.find(item => item.folders.some(folder => folder.path === path))
    if (owner && owner.id !== project?.id) void selectProject(owner.id)
  }
  const saveProject = async (input: ProjectInput) => {
    const editing = projectEditor?.project
    const saved = editing
      ? await bridge.invoke<Project>('project:update', { id: editing.id, patch: { ...input } })
      : await bridge.invoke<Project>('project:create', { ...input })
    setData(old => old ? { ...old, workspace: { ...old.workspace, projects: [...old.workspace.projects.filter(item => item.id !== saved.id), saved] } } : old)
    setProjectEditor(null)
    if (!editing) void selectProject(saved.id)
  }
  const deleteProject = async (id: string) => {
    const workspace = await bridge.invoke<Workspace>('project:delete', { id })
    for (const context of contexts.filter(item => item.projectId === id)) for (const terminal of context.terminals) disposeTerminal(terminal.id)
    setData(old => old ? { ...old, workspace } : old)
    setSelectedProjectId(workspace.selectedProject ?? ''); setProjectEditor(null)
  }
  const addFolderToProject = async (id: string, path: string) => {
    const target = projects.find(item => item.id === id)
    if (!target) return
    try {
      const saved = await bridge.invoke<Project>('project:update', { id, patch: { folders: [...target.folders, { path }] } })
      setData(old => old ? { ...old, workspace: { ...old.workspace, projects: old.workspace.projects.map(item => item.id === saved.id ? saved : item) } } : old)
      notify(`Added ${folderName(path)} to ${saved.name}. New agents in the project can work in it.`)
    } catch (cause) { notify((cause as Error).message) }
  }
  const markedFolders: MarkedFolder[] = projects.flatMap(item => {
    const running = contexts.some(context => context.projectId === item.id && context.terminals.some(terminal => terminal.terminalRunning))
    return item.folders.map(folder => ({ path: folder.path, color: item.color, running }))
  })
  const selectContext = async (context: RepoContext) => {
    const request = ++selectionRequest.current
    if (activeTerminal) await flushTerminalDraft(activeTerminal.id)
    if (request !== selectionRequest.current) return
    setActiveContextId(context.id); setRenaming(false); setDeleteContextId(null)
    try { const workspace = await bridge.invoke<Workspace>('selectContext', { id: context.id }); if (request === selectionRequest.current) setData(old => old ? { ...old, workspace } : old) }
    catch (cause) { notify((cause as Error).message) }
  }
  const patchTerminal = async (id: string, patch: Partial<TerminalResource>) => bridge.invoke('patchTerminal', { id, patch })
  const newContext = async (request: TerminalLaunchRequest, target: Project) => {
    setBusy(true)
    try {
      const context = await bridge.invoke<RepoContext>('newContext', { project: target.id, name: request.contextName, terminalName: request.terminalName, terminalKind: request.terminalKind, profile: request.profile, providerModel: request.providerModel })
      setData(old => old ? { ...old, workspace: { ...old.workspace, contexts: [...old.workspace.contexts.filter(item => item.id !== context.id), context], selectedProject: target.id, selectedContexts: { ...old.workspace.selectedContexts, [target.id]: context.id } } } : old)
      setSelectedProjectId(target.id); setActiveContextId(context.id); setView('terminals')
      if (context.terminals[0]) setActiveTerminals(current => ({ ...current, [context.id]: context.terminals[0].id }))
    } catch (cause) { notify((cause as Error).message) }
    finally { setBusy(false); setPendingLaunch(null) }
  }
  const addTerminal = async (request: TerminalLaunchRequest, context: RepoContext) => {
    setBusy(true)
    try {
      const terminal = await bridge.invoke<TerminalResource>('newTerminal', { contextId: context.id, terminalName: request.terminalName, terminalKind: request.terminalKind, profile: request.profile, providerModel: request.providerModel })
      setActiveTerminals(current => ({ ...current, [context.id]: terminal.id })); setView('terminals')
      setData(old => old ? { ...old, workspace: { ...old.workspace, contexts: old.workspace.contexts.map(item => item.id === context.id ? { ...item, terminals: [...item.terminals, terminal] } : item) } } : old)
    } catch (cause) { notify((cause as Error).message) }
    finally { setBusy(false); setPendingLaunch(null) }
  }
  const stopTerminal = async (terminal: TerminalResource) => {
    setData(old => old ? { ...old, workspace: { ...old.workspace, contexts: old.workspace.contexts.map(context => ({ ...context, terminals: context.terminals.map(item => item.id === terminal.id ? { ...item, terminalRunning: false } : item) })) } } : old)
    try { await bridge.invoke('terminalClose', { id: terminal.id }) } catch (cause) { notify((cause as Error).message) }
  }
  const startTerminal = async (terminal: TerminalResource) => {
    try { await bridge.invoke('terminalOpen', { id: terminal.id }) } catch (cause) { notify((cause as Error).message) }
  }
  // A clicked agent notification brings its terminal forward.
  useEffect(() => bridge.onFocusTerminal?.(id => {
    const owner = data?.workspace.contexts.find(context => context.terminals.some(terminal => terminal.id === id))
    if (!owner) return
    if (owner.projectId !== project?.id) setSelectedProjectId(owner.projectId)
    setActiveTerminals(current => ({ ...current, [owner.id]: id }))
    setView('terminals')
    void selectContext(owner)
  }), [data, repo])
  /** Hand a Task to one agent terminal and show that agent beside the canvas. */
  const dispatch = async (taskId: string, terminalId: string) => {
    try {
      const terminal = allTerminals.find(item => item.id === terminalId)
      const { delivery } = await bridge.invoke<{ delivery: 'sent' | 'queued' }>('board:dispatch', { repo, taskId, terminalId })
      openDrawer(terminalId)
      if (delivery === 'queued' && terminal) notify(`${terminal.name} will get the briefing when it is idle.`)
    } catch (error) { notify((error as Error).message) }
  }
  const openBoardBrief = async (sessionId: string) => {
    try {
      const text = await bridge.invoke<string>('board:handoff', { repo, sessionId })
      setBriefing({ sessionId, title: 'Board brief', text })
    } catch (error) { notify((error as Error).message) }
  }
  // The briefing is typed in once the agent is idle, so it can be handed to
  // an agent that is still finishing its previous turn.
  const sendBriefing = async () => {
    if (!activeTerminal || !briefing) return
    if (activeTerminal.terminalKind === 'shell') { notify('Choose an agent terminal, or copy the briefing to use in a shell.'); return }
    try {
      const delivery = await bridge.invoke<'sent' | 'queued'>('terminal:deliver', { id: activeTerminal.id, text: briefing.text })
      if (delivery === 'queued') notify(`${activeTerminal.name} is busy. The briefing will be sent when it is idle.`)
      setBriefing(null)
    } catch (error) { notify((error as Error).message) }
  }
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null)
  // A clicked question notification names the board root; show its project.
  const projectsRef = useRef(projects); projectsRef.current = projects
  useEffect(() => bridge.onFocusNote?.(target => {
    const owner = projectsRef.current.find(item => item.boardRoot === target.repo)
    if (owner) setSelectedProjectId(owner.id)
    setView('tasks')
    setFocusRequest({ id: target.id, nonce: Date.now() })
  }), [])
  const toggleAll = async (run: boolean) => {
    setBusy(true)
    try {
      for (const terminal of allTerminals) {
        if (run && !terminal.terminalRunning) await bridge.invoke('terminalOpen', { id: terminal.id })
        if (!run && terminal.terminalRunning) await bridge.invoke('terminalClose', { id: terminal.id })
      }
    } catch (cause) { notify((cause as Error).message) }
    finally { setBusy(false) }
  }
  const renameContext = async () => {
    if (!activeContext || !renameInput.trim()) { setRenaming(false); return }
    const name = renameInput.trim().slice(0, 60)
    setData(old => old ? { ...old, workspace: { ...old.workspace, contexts: old.workspace.contexts.map(context => context.id === activeContext.id ? { ...context, name } : context) } } : old)
    try { await bridge.invoke('patchContext', { id: activeContext.id, patch: { name } }); setRenaming(false) }
    catch (cause) { notify((cause as Error).message) }
  }
  const removeContext = async (context: RepoContext) => {
    if (deleteContextId !== context.id) { setDeleteContextId(context.id); return }
    setDeleteContextId(null)
    try {
      for (const terminal of context.terminals) await flushTerminalDraft(terminal.id)
      await bridge.invoke('deleteContext', { id: context.id })
      for (const terminal of context.terminals) disposeTerminal(terminal.id)
      setData(old => old ? { ...old, workspace: { ...old.workspace, contexts: old.workspace.contexts.filter(item => item.id !== context.id) } } : old)
      if (activeContext?.id === context.id) setActiveContextId(repoContexts.find(item => item.id !== context.id)?.id ?? null)
    } catch (cause) { notify((cause as Error).message) }
  }
  const removeTerminal = async (terminal: TerminalResource, context: RepoContext) => {
    if (deleteTerminalId !== terminal.id) { setDeleteTerminalId(terminal.id); return }
    setDeleteTerminalId(null)
    try {
      await flushTerminalDraft(terminal.id); await bridge.invoke('deleteTerminal', { id: terminal.id })
      disposeTerminal(terminal.id)
      const remaining = context.terminals.filter(item => item.id !== terminal.id)
      setData(old => old ? { ...old, workspace: { ...old.workspace, contexts: old.workspace.contexts.map(item => item.id === context.id ? { ...item, terminals: remaining } : item) } } : old)
      if (activeTerminal?.id === terminal.id) setActiveTerminals(current => ({ ...current, [context.id]: remaining[0]?.id ?? '' }))
    } catch (cause) { notify((cause as Error).message) }
  }

  const startContext = () => {
    if (busy) return
    if (project) setPendingLaunch({ type: 'context', project })
    else setProjectEditor({ folders: browsing ? [browsing] : [] })
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.target as HTMLElement)?.closest?.('.terminal-body, input, textarea, select')) return
      if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); setSettings(value => !value) }
      if (event.key === 'Escape') { setSettings(false); setRenaming(false); setDeleteContextId(null); setDeleteTerminalId(null); setPendingLaunch(null) }
    }
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler)
  }, [])
  const [palette, setPalette] = useState(false)
  const [createRequest, setCreateRequest] = useState<{ kind: NoteKind; nonce: number } | null>(null)
  const toggleDrawer = () => {
    setView('tasks')
    setDrawerId(current => current ? null : lastDrawer.current && allTerminalIds.current.includes(lastDrawer.current) ? lastDrawer.current : agentIds.current[0] ?? allTerminalIds.current[0] ?? null)
  }
  // ⌘K opens the command palette and ⌘J toggles the terminal drawer, even
  // while a terminal has focus.
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'k') { event.preventDefault(); event.stopPropagation(); setPalette(value => !value); return }
      if (key === 'n') { event.preventDefault(); event.stopPropagation(); startContextRef.current(); return }
      if (key !== 'j') return
      event.preventDefault(); event.stopPropagation()
      toggleDrawer()
    }
    window.addEventListener('keydown', toggle, true); return () => window.removeEventListener('keydown', toggle, true)
  }, [])
  const allTerminalIds = useRef<string[]>([]); allTerminalIds.current = allTerminals.map(item => item.id)
  const startContextRef = useRef(startContext); startContextRef.current = startContext
  const paletteActions: PaletteAction[] = [
    { id: 'new-task', label: 'New task', hint: 'T on the canvas', keywords: 'create add todo', run: () => { setView('tasks'); setCreateRequest({ kind: 'task', nonce: Date.now() }) } },
    { id: 'new-note', label: 'New note', hint: 'N on the canvas', keywords: 'create add idea', run: () => { setView('tasks'); setCreateRequest({ kind: 'note', nonce: Date.now() }) } },
    { id: 'new-agent', label: 'New agent…', hint: 'Start Claude Code, Codex, or any CLI', keywords: 'session terminal launch claude codex cursor', run: startContext },
    { id: 'new-project', label: 'New project…', hint: 'A named set of folders agents work across', keywords: 'create folders workspace', run: () => setProjectEditor({ folders: browsing && !projects.some(item => item.folders.some(folder => folder.path === browsing)) ? [browsing] : [] }) },
    ...(project ? [{ id: 'edit-project', label: `Edit ${project.name}…`, hint: 'Name, description, folders', keywords: 'project settings folders rename', run: () => setProjectEditor({ project }) }] : []),
    { id: 'drawer', label: 'Toggle terminal drawer', hint: '⌘J', keywords: 'terminal panel', run: toggleDrawer },
    { id: 'tasks', label: 'Go to Tasks canvas', keywords: 'board view', run: () => setView('tasks') },
    { id: 'sessions', label: 'Go to Sessions', keywords: 'terminals full screen view', run: () => setView('terminals') },
    ...projects.filter(item => item.id !== project?.id).map(item => ({ id: `project:${item.id}`, label: `Switch to ${item.name}`, hint: item.folders.map(folder => folderName(folder.path)).join(', '), keywords: 'project folders', run: () => { void selectProject(item.id) } })),
  ]
  const agentIds = useRef<string[]>([]); agentIds.current = agentTerminals.map(item => item.id)
  useEffect(() => {
    if (!settings) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!settingsPanel.current?.contains(target) && !settingsTrigger.current?.contains(target)) setSettings(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [settings])
  if (!data) return <main className="boot"><Bot size={32} /><h1>Agent Hub</h1><p>{loadingError || 'Opening your workspace…'}</p>{loadingError ? <button onClick={() => window.location.reload()}>Try again</button> : <Loader2 className="spin" />}</main>

  return <div className={`app-shell ${sidebar ? '' : 'sidebar-hidden'} ${bridge.desktop ? 'desktop' : 'browser'}`} style={sidebar ? { gridTemplateColumns: `${sideWidth}px minmax(0,1fr)` } : undefined}>
    <header className="titlebar">
      <div className="titlebar-left"><span className="brand-mark"><Bot size={19} /></span><span className="brand">Agent Hub</span><button className="icon-button no-drag" onClick={() => setSidebar(value => !value)} aria-label={sidebar ? 'Hide folder browser' : 'Show folder browser'} title={sidebar ? 'Hide folders' : 'Show folders'} aria-expanded={sidebar}>{sidebar ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button></div>
      <div className="titlebar-context">{project ? <><i className="project-swatch" style={{ background: project.color }} /><span title={project.folders.map(folder => folder.path).join('\n')}>{project.name}</span></> : <><Folder size={14} /><span>No project</span></>}</div>
      <nav className="hub-nav-tabs no-drag" role="tablist" aria-label="Workspace view">
        <button role="tab" aria-selected={view === 'tasks'} className={view === 'tasks' ? 'active' : ''} onClick={() => setView('tasks')}><Layers3 size={15} />Tasks</button>
        <button role="tab" aria-selected={view === 'terminals'} className={view === 'terminals' ? 'active' : ''} onClick={() => setView('terminals')}><Terminal size={15} />Sessions</button>
      </nav>
      <div className="titlebar-right no-drag"><span className="connection" title={bridge.desktop ? `${runningCount} running terminal${runningCount === 1 ? '' : 's'}` : 'Browser preview · sample workspaces · local changes only'}><span className={`status-dot${runningCount ? ' working' : ''}`} />{bridge.desktop ? (runningCount ? `${runningCount} running` : 'Local') : 'Preview'}</span><button ref={settingsTrigger} className="icon-button" onClick={() => setSettings(value => !value)} aria-label="Settings" title="Settings (⌘,)"><Settings2 size={17} /></button></div>
    </header>
    {sidebar && <aside className="sidebar" aria-label="Projects and folders"><ProjectsPanel projects={projects} current={project} contexts={contexts} browsing={browsing} busy={busy} onSelect={id => void selectProject(id)} onCreate={folders => setProjectEditor({ folders })} onEdit={id => setProjectEditor({ project: projects.find(item => item.id === id) })} onNewSession={startContext} onAddFolder={(id, path) => void addFolderToProject(id, path)} /><FolderBrowser selected={browsing} marked={markedFolders} onSelect={path => void selectRepo(path)} onError={notify} /><div className="sidebar-resize" role="separator" aria-orientation="vertical" aria-label="Resize folder browser" tabIndex={0} onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); sideDrag.current = { startX: event.clientX, startW: sideWidth } }} onPointerMove={event => { const drag = sideDrag.current; if (drag) setSideWidth(clampSide(drag.startW + event.clientX - drag.startX)) }} onPointerUp={() => { sideDrag.current = null; try { localStorage.setItem('agent-hub-sidebar-width', String(sideWidth)) } catch {} }} onPointerCancel={() => { sideDrag.current = null }} onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') setSideWidth(value => clampSide(value + (event.key === 'ArrowRight' ? 12 : -12))) }} /></aside>}
    <main className="workspace">
      {data.error && <div className="connection-error"><span>{data.error}</span><button onClick={() => void bridge.invoke<Bootstrap>('bootstrap').then(setData)}>Reconnect</button></div>}
      <div className="tasks-stage" style={view === 'tasks' ? undefined : { display: 'none' }}>
        {project ? <BoardCanvas key={project.id} repo={repo} sessions={repoContexts} isVisible={view === 'tasks'} focusRequest={focusRequest} createRequest={createRequest} onError={notify} onDispatch={(taskId, terminalId) => void dispatch(taskId, terminalId)} onOpenTerminal={openDrawer} onNewAgent={startContext} /> : <div className="empty-workspace project-welcome"><h2>Start with a project</h2><p>A project is a named set of folders. Its agents start in the primary folder and can read and edit all of them, and its tasks, notes, and codebase context share one board.</p><button className="primary-button" onClick={() => setProjectEditor({ folders: browsing ? [browsing] : [] })}><Plus size={15} /> New project{browsing ? ` from ${folderName(browsing)}` : ''}</button></div>}
        {view === 'tasks' && drawerTerminal && <AgentDrawer terminal={drawerTerminal} sessions={repoContexts} width={drawerWidth} onWidth={resizeDrawer} onSelect={openDrawer} onClose={() => setDrawerId(null)} onError={notify} patch={patchTerminal} themeMode={themeMode} themeBackground={customBg} themeAccent={customAccent}
          onExpand={() => { const owner = repoContexts.find(context => context.terminals.some(item => item.id === drawerTerminal.id)); if (owner) { setActiveTerminals(current => ({ ...current, [owner.id]: drawerTerminal.id })); void selectContext(owner) } setDrawerId(null); setView('terminals') }} />}
      </div>{view === 'terminals' && <section className="contexts-view" aria-label="Agent Sessions">
        <div className="sessions-strip"><div className="context-tabs" role="tablist" aria-label={`Sessions in ${project?.name ?? 'this project'}`}>
          {repoContexts.map(context => <button role="tab" aria-selected={activeContext?.id === context.id} className={`context-tab${activeContext?.id === context.id ? ' active' : ''}`} key={context.id} onClick={() => void selectContext(context)} title={`${context.name} · ${context.terminals.length} terminals · ${STATE_LABELS[mostUrgent(context.terminals)]}`}><span className={`status-dot state-${mostUrgent(context.terminals)}`} /><span className="context-tab-name">{context.name}</span><small>{context.terminals.length}</small></button>)}
          <button className="icon-button context-tab-add" aria-label="New Session" title="New Session" disabled={busy || !project} onClick={startContext}><Plus size={15} /></button>
        </div><div className="contexts-actions">{activeContext && <button className="small-button" title="Give any running agent the shared board context" onClick={() => void openBoardBrief(activeContext.id)}><BookOpen size={13} />Board brief</button>}{runningCount > 0 && <button className="small-button" disabled={busy} onClick={() => void toggleAll(false)}><Square size={13} />Stop all</button>}{runningCount < allTerminals.length && allTerminals.length > 0 && <button className="small-button" disabled={busy} onClick={() => void toggleAll(true)}><Play size={13} />Start all</button>}{activeContext && <button className="small-button" onClick={() => { setRenameInput(activeContext.name); setRenaming(true) }}><Pencil size={13} />Rename</button>}{activeContext && <button className={`small-button${deleteContextId === activeContext.id ? ' danger-armed' : ''}`} onClick={() => void removeContext(activeContext)}><Trash2 size={13} />{deleteContextId === activeContext.id ? 'Delete Session?' : 'Delete'}</button>}</div></div>
        {activeContext ? <>
          {briefing?.sessionId === activeContext.id && <div className="session-briefing"><div><strong>{briefing.title === 'Board brief' ? briefing.title : `Task: ${briefing.title}`}</strong><span>{briefing.title === 'Board brief' ? 'Send this context to any running agent, or copy it for another CLI.' : 'Send the task and linked context to the active agent.'}</span></div><button className="small-button" onClick={() => void navigator.clipboard.writeText(briefing.text).then(() => notify('Briefing copied.')).catch(error => notify((error as Error).message))}>Copy briefing</button><button className="primary-button" disabled={!activeTerminal || activeTerminal.terminalKind === 'shell'} onClick={() => void sendBriefing()}>Send to agent</button><button className="icon-button" aria-label="Dismiss briefing" onClick={() => setBriefing(null)}><X size={14} /></button></div>}
          <div className="terminal-tabs" role="tablist" aria-label={`Terminals in ${activeContext.name}`}>
            {activeContext.terminals.map(terminal => <div key={terminal.id} className={`terminal-tab${activeTerminal?.id === terminal.id ? ' active' : ''}`}>
              <button role="tab" aria-selected={activeTerminal?.id === terminal.id} className="terminal-tab-main" onClick={() => { if (activeTerminal) void flushTerminalDraft(activeTerminal.id); setActiveTerminals(current => ({ ...current, [activeContext.id]: terminal.id })) }} title={`${terminal.agent} · ${terminalStatus(terminal)}`}><span className={`status-dot state-${terminalState(terminal)}`} /><span>{terminal.name}</span><small className={`terminal-status state-${terminalState(terminal)}`}>{terminalStatus(terminal)}</small></button>
              {terminal.terminalRunning ? <button className="icon-button" aria-label={`Stop ${terminal.name}`} title={`Stop ${terminal.agent}`} onClick={() => void stopTerminal(terminal)}><Square size={12} /></button> : <button className="icon-button" aria-label={`Start ${terminal.name}`} title={`Start ${terminal.agent}`} onClick={() => void startTerminal(terminal)}><Play size={12} /> </button>}
              {activeContext.terminals.length > 1 && <button className={`icon-button terminal-remove${deleteTerminalId === terminal.id ? ' danger-armed' : ''}`} aria-label={deleteTerminalId === terminal.id ? `Confirm remove ${terminal.name}` : `Remove ${terminal.name}`} title={deleteTerminalId === terminal.id ? 'Click again to remove' : 'Remove terminal'} onClick={() => void removeTerminal(terminal, activeContext)}>{deleteTerminalId === terminal.id ? <Check size={13} /> : <X size={13} />}</button>}
            </div>)}
            <button className="small-button add-terminal" disabled={busy} onClick={() => setPendingLaunch({ type: 'terminal', context: activeContext })}><Plus size={14} />Add terminal</button>
          </div>
          {renaming ? <div className="rename-context"><label>Session name<input autoFocus maxLength={60} value={renameInput} onChange={event => setRenameInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void renameContext(); if (event.key === 'Escape') setRenaming(false) }} /></label><button className="small-button" onClick={() => setRenaming(false)}>Cancel</button><button className="small-button" onClick={() => void renameContext()}>Save name</button></div> : null}
          {activeTerminal ? <div className="single-view"><TerminalView key={activeTerminal.id} session={activeTerminal} onError={notify} patch={activeTerminal.terminalKind === 'shell' ? undefined : patchTerminal} themeMode={themeMode} themeBackground={customBg} themeAccent={customAccent} /></div> : <div className="empty-workspace"><h2>No terminals in this Session</h2><button className="primary-button" onClick={() => setPendingLaunch({ type: 'terminal', context: activeContext })}><Plus size={15} />Add terminal</button></div>}
        </> : <div className="empty-workspace"><h2>No Sessions in this workspace</h2><p>Create a Session to keep agents and shells together while you work.</p><button className="primary-button" disabled={busy || !repo} onClick={startContext}><Plus size={15} />Create a Session</button></div>}
      </section>}
    </main>
    {settings && <section ref={settingsPanel} className="settings-panel" aria-label="Settings"><header><h2>Workspace settings</h2><button className="icon-button" aria-label="Close settings" onClick={() => setSettings(false)}><X size={17} /></button></header><label>Appearance</label><div className="theme-options">{([['dark', Moon, 'Dark'], ['light', Sun, 'Light'], ['system', Monitor, 'System']] as const).map(([value, Icon, label]) => <button key={value} aria-pressed={data.workspace.theme === value} onClick={() => void bridge.invoke('preferences', { theme: value })}><Icon size={19} />{label}</button>)}</div><label className="theme-colour">Background<input type="color" aria-label="Custom background colour" value={customBg ?? DEFAULT_CANVAS[themeMode]} onChange={event => void bridge.invoke('preferences', { themeBackground: event.target.value })} /></label><label className="theme-colour">Accent<input type="color" aria-label="Custom accent colour" value={customAccent ?? DEFAULT_ACCENT[themeMode]} onChange={event => void bridge.invoke('preferences', { themeAccent: event.target.value })} /></label><p>Appearance applies to the workspace and terminal. Sessions and drafts save automatically.</p><small className="settings-version">Agent Hub 0.3.0</small></section>}
    {notice && <div className="toast" role="status"><span>{notice}</span><button aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={15} /></button></div>}
    {palette && <CommandPalette repo={repo} terminals={allTerminals} actions={paletteActions} onClose={() => setPalette(false)}
      onNote={note => { setView('tasks'); setFocusRequest({ id: note.id, nonce: Date.now() }) }}
      onTerminal={terminal => { setView('tasks'); openDrawer(terminal.id) }} />}
    {projectEditor && <ProjectModal project={projectEditor.project} initialFolders={projectEditor.folders} suggestedFolder={browsing} onSave={saveProject} onCancel={() => setProjectEditor(null)} onDelete={projectEditor.project ? () => deleteProject(projectEditor.project!.id) : undefined} />}
    {pendingLaunch && <LaunchModal repo={pendingLaunch.type === 'context' ? pendingLaunch.project.name : project?.name} contextId={pendingLaunch.type === 'terminal' ? pendingLaunch.context.id : undefined} contextName={pendingLaunch.type === 'terminal' ? pendingLaunch.context.name : undefined} onCancel={() => setPendingLaunch(null)} onConfirm={request => { if (pendingLaunch.type === 'context') void newContext(request, pendingLaunch.project); else void addTerminal(request, pendingLaunch.context) }} />}
  </div>
}

export default function App() { return <WorkspaceApp /> }
