import { FolderPlus, Plus, Settings2 } from 'lucide-react'
import { mostUrgent } from './agentState'
import type { Project, RepoContext } from './types'

const baseName = (path: string) => path.split('/').filter(Boolean).at(-1) || path

/** The project list above the file browser: pick a project, start a
 *  Session in it, and add the folder selected below to it. */
export default function ProjectsPanel({ projects, current, contexts, browsing, busy, onSelect, onCreate, onEdit, onNewSession, onAddFolder }: {
  projects: Project[]; current: Project | null; contexts: RepoContext[]
  /** The folder selected in the file browser. */
  browsing: string; busy: boolean
  onSelect: (id: string) => void; onCreate: (folders: string[]) => void; onEdit: (id: string) => void
  onNewSession: () => void; onAddFolder: (projectId: string, path: string) => void
}) {
  const owner = projects.find(project => project.folders.some(folder => folder.path === browsing))
  return <section className="projects-panel" aria-label="Projects">
    <button className="new-session" disabled={busy || !current} onClick={onNewSession} title={current ? `New Session in ${current.name}` : 'Create a project first'}>
      <Plus size={17} /><span>New Session</span><kbd>⌘ N</kbd>
    </button>
    <div className="projects-head"><span>Projects</span><button className="icon-button" aria-label="New project" title="New project" onClick={() => onCreate(browsing && !owner ? [browsing] : [])}><Plus size={14} /></button></div>
    <div className="projects-list" role="listbox" aria-label="Projects">
      {projects.map(project => {
        const sessions = contexts.filter(context => context.projectId === project.id)
        const state = mostUrgent(sessions.flatMap(context => context.terminals))
        return <div key={project.id} role="option" aria-selected={project.id === current?.id} className={`project-row${project.id === current?.id ? ' active' : ''}`}>
          <button className="project-row-main" onClick={() => onSelect(project.id)} title={project.folders.map(folder => folder.path).join('\n')}>
            <i className="project-swatch" style={{ background: project.color }} />
            <span className="project-row-name">{project.name}</span>
            <small>{project.folders.length === 1 ? baseName(project.folders[0].path) : `${project.folders.length} folders`}</small>
            {state !== 'stopped' && <span className={`status-dot state-${state}`} />}
          </button>
          <button className="icon-button project-row-edit" aria-label={`Edit ${project.name}`} title="Edit project" onClick={() => onEdit(project.id)}><Settings2 size={13} /></button>
        </div>
      })}
      {!projects.length && <p className="projects-empty">Group folders into a project; its agents work across all of them. Select a folder below, then press +.</p>}
    </div>
    {browsing && !owner && <div className="project-folder-callout">
      <span title={browsing}><FolderPlus size={13} /> {baseName(browsing)}</span>
      {current && <button className="small-button" disabled={busy} onClick={() => onAddFolder(current.id, browsing)}>Add to {current.name}</button>}
      <button className="small-button" disabled={busy} onClick={() => onCreate([browsing])}>New project</button>
    </div>}
  </section>
}
