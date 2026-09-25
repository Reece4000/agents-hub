import { useEffect, useState } from 'react'
import { ArrowUp, FolderPlus, Star, Trash2, X } from 'lucide-react'
import { bridge } from './bridge'
import type { Project, ProjectFolder } from './types'

const COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff', '#f7768e', '#73daca', '#ff9e64']
const baseName = (path: string) => path.split('/').filter(Boolean).at(-1) || path

export interface ProjectInput { name: string; description: string; color: string; folders: ProjectFolder[] }

/** Create or edit a project: its name, description, colour, and folders.
 *  The first folder is primary: agents start there and reach the others. */
export default function ProjectModal({ project, initialFolders = [], suggestedFolder, onSave, onDelete, onCancel }: {
  project?: Project
  initialFolders?: string[]
  /** The folder selected in the file browser, offered as a quick add. */
  suggestedFolder?: string
  onSave: (input: ProjectInput) => Promise<void>
  onDelete?: () => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState(project?.name ?? (initialFolders[0] ? baseName(initialFolders[0]) : ''))
  const [description, setDescription] = useState(project?.description ?? '')
  const [color, setColor] = useState(project?.color ?? COLORS[0])
  const [folders, setFolders] = useState<ProjectFolder[]>(project?.folders ?? initialFolders.map(path => ({ path })))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onCancel() } }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [onCancel])
  const add = (path: string | null | undefined) => {
    if (!path) return
    setFolders(current => current.some(folder => folder.path === path) ? current : [...current, { path }])
    if (!name.trim()) setName(baseName(path))
  }
  const pick = async () => { try { add(await bridge.invoke<string | null>('chooseRepo')) } catch (cause) { setError((cause as Error).message) } }
  const update = (index: number, patch: Partial<ProjectFolder>) => setFolders(current => current.map((folder, position) => position === index ? { ...folder, ...patch } : folder))
  const move = (index: number, to: number) => setFolders(current => { const next = [...current]; const [item] = next.splice(index, 1); next.splice(to, 0, item); return next })
  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault()
    if (!folders.length) { setError('Add at least one folder.'); return }
    setBusy(true); setError('')
    try { await onSave({ name: name.trim() || baseName(folders[0].path), description: description.trim(), color, folders }) }
    catch (cause) { setError((cause as Error).message) } finally { setBusy(false) }
  }
  const title = project ? `Edit ${project.name}` : 'New project'
  return <div className="modal-overlay" onPointerDown={event => { if (event.target === event.currentTarget) onCancel() }}>
    <form className="modal project-modal" role="dialog" aria-modal="true" aria-label={title} onSubmit={submit}>
      <header className="modal-header">
        <h2>{title}</h2>
        <p>A project is a set of folders. Its agents start in the primary folder and can read and edit all of them; its tasks and notes live on one board.</p>
      </header>
      <div className="modal-fields">
        <div className="project-name-row">
          <label>Name<input autoFocus value={name} maxLength={80} placeholder="Storefront" onChange={event => setName(event.target.value)} /></label>
          <div className="project-colors" role="radiogroup" aria-label="Colour">{COLORS.map(value => <button type="button" role="radio" aria-checked={color === value} aria-label={value} key={value} className={color === value ? 'selected' : ''} style={{ background: value }} onClick={() => setColor(value)} />)}</div>
        </div>
        <label>Description <small>Optional · shown to agents</small><textarea rows={2} value={description} maxLength={2000} placeholder="What this project is, and anything agents should know about how its folders fit together." onChange={event => setDescription(event.target.value)} /></label>
        <fieldset className="project-folders">
          <legend>Folders</legend>
          {folders.map((folder, index) => <div className="project-folder" key={folder.path}>
            <div className="project-folder-head">
              {index === 0 ? <span className="project-primary" title="Primary folder: agents start here"><Star size={12} /> Primary</span> : <button type="button" className="icon-button" title="Make primary" aria-label={`Make ${baseName(folder.path)} primary`} onClick={() => move(index, 0)}><ArrowUp size={13} /></button>}
              <strong title={folder.path}>{baseName(folder.path)}</strong>
              <small title={folder.path}>{folder.path}</small>
              <button type="button" className="icon-button" aria-label={`Remove ${baseName(folder.path)}`} title="Remove from project" onClick={() => setFolders(current => current.filter((_, position) => position !== index))}><X size={13} /></button>
            </div>
            <div className="project-folder-fields">
              <input aria-label={`Label for ${baseName(folder.path)}`} value={folder.label ?? ''} placeholder="Label (e.g. web, api)" maxLength={60} onChange={event => update(index, { label: event.target.value })} />
              <input aria-label={`Note for ${baseName(folder.path)}`} value={folder.note ?? ''} placeholder="Note for agents (optional)" maxLength={500} onChange={event => update(index, { note: event.target.value })} />
            </div>
          </div>)}
          <div className="project-folder-add">
            {bridge.desktop && <button type="button" className="small-button" onClick={() => void pick()}><FolderPlus size={14} /> Add folder…</button>}
            {suggestedFolder && !folders.some(folder => folder.path === suggestedFolder) && <button type="button" className="small-button" onClick={() => add(suggestedFolder)} title={suggestedFolder}><FolderPlus size={14} /> Add {baseName(suggestedFolder)}</button>}
            {!folders.length && <small>Pick folders here, or select one in the file browser first.</small>}
          </div>
        </fieldset>
        {error && <p className="modal-warning" role="alert">{error}</p>}
      </div>
      <footer className="modal-actions">
        {onDelete && <button type="button" className={`small-button${confirmDelete ? ' danger-armed' : ''}`} disabled={busy} onClick={() => { if (!confirmDelete) { setConfirmDelete(true); return } setBusy(true); void onDelete().catch(cause => { setError((cause as Error).message); setBusy(false) }) }}><Trash2 size={13} />{confirmDelete ? 'Stop its agents and delete?' : 'Delete project'}</button>}
        <span className="modal-actions-spacer" />
        <button type="button" className="small-button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || !folders.length}>{project ? 'Save project' : 'Create project'}</button>
      </footer>
    </form>
  </div>
}
