import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'
import { ArrowDownRight, BookOpen, Check, ChevronDown, ChevronRight, CircleHelp, Command, CornerDownRight, FileText, Focus, Folder, Grip, History, ImagePlus, Mic, Layers3, Link2, Maximize2, Minus, MoreHorizontal, Plus, Search, Trash2, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { bridge } from './bridge'
import OrganizerPanel from './OrganizerPanel'
import { zoomAtCursor } from './viewport'
import type { RepoContext, Viewport } from './types'
import type { BoardCommand, BoardNote, BoardPosition, BoardQuery, BoardSection, BoardSnapshot, NoteKind, TaskState } from '../shared/board'
import { cardWidth, cardHeight, withMissingPositions } from '../shared/board-layout'
import './board.css'

const kindLabel: Record<NoteKind, string> = { task: 'Task', context: 'Codebase context', note: 'Note' }
const statusLabel: Record<TaskState, string> = { open: 'Open', working: 'Working', blocked: 'Blocked', done: 'Done' }
const blank: BoardSnapshot = { repo: '', notes: [], sections: [], positions: {}, errors: [], readOnly: false }
const placed = (value: BoardSnapshot): BoardSnapshot => ({ ...value, positions: withMissingPositions(value.notes, value.positions) })
const date = (value: string) => { const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(d) }
const kindIcon = (kind: NoteKind) => kind === 'task' ? <Check size={13} /> : kind === 'context' ? <BookOpen size={13} /> : <FileText size={13} />
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))
const linkCurve = (from: BoardPosition, to: BoardPosition, point = false) => {
  const right = to.x >= from.x, direction = right ? 1 : -1
  const startX = from.x + (right ? cardWidth : 0), startY = from.y + cardHeight / 2
  const endX = to.x + (point ? 0 : right ? 0 : cardWidth), endY = to.y + (point ? 0 : cardHeight / 2)
  const reach = Math.max(70, Math.abs(endX - startX) * .45)
  return `M ${startX} ${startY} C ${startX + direction * reach} ${startY}, ${endX - direction * reach} ${endY}, ${endX} ${endY}`
}

type Menu = { x: number; y: number; world: BoardPosition; target?: string; section?: string }
type Capture = { kind: NoteKind; position: BoardPosition; x: number; y: number }
type Drag = { type: 'pan' | 'note' | 'section' | 'resize'; id?: string; startX: number; startY: number; startViewport: Viewport; startPosition?: BoardPosition; startSection?: BoardSection; originalPositions?: Record<string, BoardPosition>; moved: boolean }

export default function BoardCanvas({ repo, sessions, isVisible = true, onWork, onError }: { repo: string; sessions: RepoContext[]; isVisible?: boolean; onWork: (sessionId: string, task: BoardNote) => void; onError: (message: string) => void }) {
  const [snapshot, setSnapshot] = useState<BoardSnapshot>(blank)
  const [positions, setPositions] = useState<Record<string, BoardPosition>>({})
  const [sections, setSections] = useState<BoardSection[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [organizing, setOrganizing] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusTitleId, setFocusTitleId] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [linkFrom, setLinkFrom] = useState<string | null>(null)
  const [linkCursor, setLinkCursor] = useState<BoardPosition | null>(null)
  const [capture, setCapture] = useState<Capture | null>(null)
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [filter, setFilter] = useState<NoteKind | 'all'>('all')
  const [filterOpen, setFilterOpen] = useState(false)
  const [showDone, setShowDone] = useState(true)
  const [showTrash, setShowTrash] = useState(false)
  const [trash, setTrash] = useState<BoardNote[]>([])
  const [renamingSection, setRenamingSection] = useState<string | null>(null)
  const [sectionName, setSectionName] = useState('')
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 })
  const [surfaceSize, setSurfaceSize] = useState({ width: 1200, height: 800 })
  const surface = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const drag = useRef<Drag | null>(null)
  const linkPointer = useRef<{ from: string; x: number; y: number; moved: boolean } | null>(null)
  const suppressOpen = useRef<string | null>(null)
  const beforeSwitch = useRef<(() => Promise<boolean>) | null>(null)
  const initialized = useRef<string | null>(null)
  const positionsRef = useRef(positions), sectionsRef = useRef(sections), viewportRef = useRef(viewport)
  positionsRef.current = positions; sectionsRef.current = sections; viewportRef.current = viewport
  const editorWidth = Math.min(440, Math.max(280, surfaceSize.width - 24))
  const editorHeight = Math.min(600, Math.max(240, surfaceSize.height - 24))
  const visible = useMemo(() => snapshot.notes.filter(note => showDone || note.status !== 'done'), [snapshot.notes, showDone])
  const rendered = useMemo(() => visible.filter(note => {
    if (note.id === selectedId) return true
    const position = positions[note.id] ?? { x: 100, y: 100 }
    const left = position.x * viewport.zoom + viewport.x, top = position.y * viewport.zoom + viewport.y
    return left < surfaceSize.width + 250 && top < surfaceSize.height + 250 && left + cardWidth * viewport.zoom > -250 && top + cardHeight * viewport.zoom > -250
  }), [visible, positions, viewport, surfaceSize, selectedId])
  const matches = useMemo(() => snapshot.notes.filter(note => (!search.trim() || `${note.title}\n${note.body}\n${note.subject ?? ''}\n${(note.acceptance ?? []).join('\n')}\n${(note.evidence ?? []).map(item => item.path).join('\n')}`.toLowerCase().includes(search.toLowerCase())) && (filter === 'all' || note.kind === filter)), [snapshot.notes, search, filter])
  const matchIds = new Set(matches.map(note => note.id))
  const counts = useMemo(() => ({ task: snapshot.notes.filter(n => n.kind === 'task').length, context: snapshot.notes.filter(n => n.kind === 'context').length, note: snapshot.notes.filter(n => n.kind === 'note').length }), [snapshot.notes])

  const refresh = useCallback(async () => {
    const value = placed(await bridge.invoke<BoardSnapshot>('board:load', { repo }))
    setLoadError(''); setSnapshot(value); setPositions(value.positions); setSections(value.sections)
    return value
  }, [repo])
  useEffect(() => {
    let live = true
    setLoading(true); setLoadError(''); setSelectedId(null); setLinkFrom(null); setSnapshot(blank); setPositions({}); setSections([]);
    bridge.invoke<BoardSnapshot>('board:load', { repo }).then(raw => { if (live) { const value = placed(raw); setSnapshot(value); setPositions(value.positions); setSections(value.sections) } }).catch(error => { if (live) setLoadError((error as Error).message) }).finally(() => { if (live) setLoading(false) })
    const stop = bridge.onBoard?.(raw => { if (live && raw.repo === repo) { const value = placed(raw); setSnapshot(value); if (!drag.current) { setPositions(value.positions); setSections(value.sections) } } })
    return () => { live = false; stop?.() }
  }, [repo])
  useEffect(() => {
    if (!surface.current) return
    const observer = new ResizeObserver(entries => { const rect = entries[0]?.contentRect; if (rect) setSurfaceSize({ width: rect.width, height: rect.height }) })
    observer.observe(surface.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (loading || initialized.current === repo || !surface.current) return
    initialized.current = repo
    try {
      const saved = JSON.parse(localStorage.getItem(`agent-hub-canvas-view:${repo}`) || 'null')
      if (saved && [saved.x, saved.y, saved.zoom].every(Number.isFinite) && saved.zoom >= .35 && saved.zoom <= 1.8) { setViewport(saved); return }
    } catch {}
    requestAnimationFrame(() => fit(snapshot, surface.current, setViewport))
  }, [loading, repo, snapshot])
  useEffect(() => { const t = setTimeout(() => { try { localStorage.setItem(`agent-hub-canvas-view:${repo}`, JSON.stringify(viewport)) } catch {} }, 350); return () => clearTimeout(t) }, [viewport, repo])
  const apply = async (command: BoardCommand) => {
    if (snapshot.readOnly) { onError('This repository is read-only. Notes can be viewed but not changed.'); return null }
    try { const result = await bridge.invoke('board:apply', { repo, command }); await refresh(); return result }
    catch (error) { onError((error as Error).message); await refresh().catch(() => {}); return null }
  }
  const worldAt = (clientX: number, clientY: number): BoardPosition => {
    const rect = surface.current?.getBoundingClientRect() ?? { left: 0, top: 0 }
    const v = viewportRef.current
    return { x: Math.round((clientX - rect.left - v.x) / v.zoom), y: Math.round((clientY - rect.top - v.y) / v.zoom) }
  }
  const centerWorld = (): BoardPosition => {
    const rect = surface.current?.getBoundingClientRect() ?? { width: 900, height: 600, left: 0, top: 0 }
    const v = viewportRef.current
    const center = { x: Math.round((rect.width / 2 - v.x) / v.zoom - cardWidth / 2), y: Math.round((rect.height / 2 - v.y) / v.zoom - cardHeight / 2) }
    const occupied = Object.values(positionsRef.current)
    const offsets: Array<{ row: number; col: number }> = []
    for (let row = -5; row <= 5; row++) for (let col = -5; col <= 5; col++) offsets.push({ row, col })
    offsets.sort((a, b) => Math.hypot(a.row, a.col) - Math.hypot(b.row, b.col))
    for (const { row, col } of offsets) {
      const candidate = { x: center.x + col * (cardWidth + 28), y: center.y + row * (cardHeight + 28) }
      const screenX = candidate.x * v.zoom + v.x, screenY = candidate.y * v.zoom + v.y
      if (screenX < 20 || screenY < 20 || screenX + cardWidth * v.zoom > rect.width - 20 || screenY + cardHeight * v.zoom > rect.height - 20) continue
      if (occupied.every(pos => Math.abs(pos.x - candidate.x) >= cardWidth + 18 || Math.abs(pos.y - candidate.y) >= cardHeight + 18)) return candidate
    }
    return center
  }
  const openNote = async (id: string) => {
    if (selectedId && selectedId !== id && beforeSwitch.current && !await beforeSwitch.current()) return false
    const position = positionsRef.current[id]
    if (position) setViewport(current => {
      const left = position.x * current.zoom + current.x, top = position.y * current.zoom + current.y
      return { ...current, x: current.x + clamp(left, 12, Math.max(12, surfaceSize.width - editorWidth - 12)) - left, y: current.y + clamp(top, 12, Math.max(12, surfaceSize.height - editorHeight - 12)) - top }
    })
    setSelectedId(id); setSearchOpen(false); return true
  }
  const closeNote = (id: string, restoreFocus = true) => { setSelectedId(current => current === id ? null : current); if (restoreFocus) requestAnimationFrame(() => (surface.current?.querySelector(`[data-note-id="${id}"]`) as HTMLElement | null)?.focus()) }
  const focusNote = async (note: BoardNote) => {
    if (!await openNote(note.id)) return
    const position = positionsRef.current[note.id] ?? { x: 100, y: 100 }
    const section = sectionsRef.current.find(item => item.id === note.sectionId)
    if (section?.collapsed) { void apply({ type: 'updateSection', id: section.id, patch: { collapsed: false } }) }
    setViewport(current => ({ ...current, x: (surfaceSize.width - editorWidth) / 2 - position.x * current.zoom, y: (surfaceSize.height - editorHeight) / 2 - position.y * current.zoom }))
    setFocusTitleId(null)
  }
  const connectNotes = async (from: string, to: string) => {
    setLinkFrom(null); setLinkCursor(null)
    if (from === to) return
    const source = snapshot.notes.find(note => note.id === from)
    const target = snapshot.notes.find(note => note.id === to)
    if (!source || !target || source.links.some(link => link.to === to) || target.links.some(link => link.to === from)) return
    await apply({ type: 'updateNote', id: source.id, expectedRevision: source.revision, patch: { links: [...source.links, { to, kind: 'relates_to' }], updatedBy: 'person' } })
  }
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const pending = linkPointer.current
      if (!pending) return
      if (Math.abs(event.clientX - pending.x) + Math.abs(event.clientY - pending.y) > 5) pending.moved = true
      setLinkCursor(worldAt(event.clientX, event.clientY))
    }
    const up = (event: PointerEvent) => {
      const pending = linkPointer.current
      linkPointer.current = null; setLinkCursor(null)
      if (!pending?.moved) return
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-note-id]') as HTMLElement | null
      const id = target?.dataset.noteId
      if (id && id !== pending.from) {
        suppressOpen.current = id
        setTimeout(() => { if (suppressOpen.current === id) suppressOpen.current = null }, 0)
        void connectNotes(pending.from, id)
      }
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [snapshot.notes, repo])
  const create = async (kind: NoteKind | 'section', position: BoardPosition) => {
    setMenu(null)
    if (kind === 'section') {
      const section = await apply({ type: 'createSection', title: 'New section', position }) as BoardSection | null
      if (section) { setRenamingSection(section.id); setSectionName(section.title) }
    } else {
      const v = viewportRef.current
      const rect = surface.current?.getBoundingClientRect() ?? { width: 900, height: 600 }
      const x = position.x * v.zoom + v.x, y = position.y * v.zoom + v.y
      setCapture({ kind, position, x: clamp(x, 12, Math.max(12, rect.width - 322)), y: clamp(y, 12, Math.max(12, rect.height - 210)) })
    }
  }
  const saveCapture = async (value: Capture, text: string) => {
    const lines = text.trim().split(/\r?\n/)
    const title = lines.shift()?.trim()
    if (!title) return true
    const section = sectionsRef.current.find(s => !s.collapsed && value.position.x >= s.x && value.position.x <= s.x + s.width && value.position.y >= s.y && value.position.y <= s.y + s.height)
    const created = await apply({ type: 'createNote', note: { kind: value.kind, title, body: lines.join('\n').trim(), ...(value.kind === 'context' ? { subject: title } : {}), ...(section ? { sectionId: section.id } : {}) }, position: value.position })
    if (created) { setCapture(current => current === value ? null : current); return true }
    return false
  }
  const onWheel = (event: ReactWheelEvent) => {
    event.preventDefault()
    const rect = surface.current!.getBoundingClientRect()
    if (event.ctrlKey || event.metaKey) setViewport(value => zoomAtCursor(value, event.clientX - rect.left, event.clientY - rect.top, event.deltaY, event.deltaMode, .35, 1.8))
    else setViewport(value => ({ ...value, x: value.x - (event.shiftKey ? event.deltaY : event.deltaX), y: value.y - (event.shiftKey ? 0 : event.deltaY) }))
  }
  const startDrag = (event: ReactPointerEvent, type: Drag['type'], id?: string) => {
    if (event.button !== 0 || (snapshot.readOnly && type !== 'pan')) return
    event.preventDefault(); event.stopPropagation(); setMenu(null)
    drag.current = { type, id, startX: event.clientX, startY: event.clientY, startViewport: viewportRef.current, startPosition: id ? positionsRef.current[id] : undefined, startSection: type === 'section' || type === 'resize' ? sectionsRef.current.find(s => s.id === id) : undefined, originalPositions: type === 'section' ? { ...positionsRef.current } : undefined, moved: false }
  }
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const item = drag.current
      if (!item) return
      const dx = event.clientX - item.startX, dy = event.clientY - item.startY
      if (Math.abs(dx) + Math.abs(dy) > 3) item.moved = true
      if (item.type === 'pan') setViewport({ ...item.startViewport, x: item.startViewport.x + dx, y: item.startViewport.y + dy })
      else if (item.type === 'note' && item.id && item.startPosition) setPositions(prev => ({ ...prev, [item.id!]: { x: Math.round(item.startPosition!.x + dx / item.startViewport.zoom), y: Math.round(item.startPosition!.y + dy / item.startViewport.zoom) } }))
      else if (item.type === 'section' && item.id && item.startSection) {
        const sx = Math.round(dx / item.startViewport.zoom), sy = Math.round(dy / item.startViewport.zoom)
        setSections(prev => prev.map(s => s.id === item.id ? { ...s, x: item.startSection!.x + sx, y: item.startSection!.y + sy } : s))
        setPositions(prev => { const next = { ...prev }; for (const note of snapshot.notes.filter(n => n.sectionId === item.id)) { const start = item.originalPositions?.[note.id]; if (start) next[note.id] = { x: start.x + sx, y: start.y + sy } } return next })
      }
      else if (item.type === 'resize' && item.id && item.startSection) setSections(prev => prev.map(s => s.id === item.id ? { ...s, width: clamp(Math.round(item.startSection!.width + dx / item.startViewport.zoom), 340, 4000), height: clamp(Math.round(item.startSection!.height + dy / item.startViewport.zoom), 180, 4000) } : s))
    }
    const up = () => {
      const item = drag.current; drag.current = null
      if (!item?.id) return
      if (!item.moved && item.type === 'note') { setFocusTitleId(item.id); void openNote(item.id); return }
      if (!item.moved) return
      if (item.type === 'note') {
        suppressOpen.current = item.id
        setTimeout(() => { if (suppressOpen.current === item.id) suppressOpen.current = null }, 0)
        const position = positionsRef.current[item.id]
        const note = snapshot.notes.find(n => n.id === item.id)
        if (!position || !note) return
        const center = { x: position.x + cardWidth / 2, y: position.y + cardHeight / 2 }
        const target = sectionsRef.current.find(s => !s.collapsed && center.x >= s.x && center.x <= s.x + s.width && center.y >= s.y && center.y <= s.y + s.height)
        void apply({ type: 'moveNote', id: item.id, position, sectionId: target?.id ?? '', expectedRevision: note.revision })
      } else if (item.type === 'section' || item.type === 'resize') {
        const section = sectionsRef.current.find(s => s.id === item.id)
        if (section) void apply({ type: 'updateSection', id: section.id, patch: item.type === 'resize' ? { width: section.width, height: section.height } : { x: section.x, y: section.y } })
      }
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up) }
  }, [snapshot.notes, repo, snapshot.readOnly])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!isVisible) return
      if (event.key === 'Escape') {
        setMenu(null); setSearchOpen(false); setFilterOpen(false); setShowTrash(false); setLinkFrom(null); setLinkCursor(null)
        if (selectedId && !(event.target instanceof Element && event.target.closest('select'))) {
          const commit = beforeSwitch.current
          void (commit ? commit() : Promise.resolve(true)).then(ok => { if (ok) closeNote(selectedId) })
        }
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchInput.current?.focus(); setSearchOpen(true); return }
      const target = event.target as HTMLElement
      if (target.closest('input,textarea,select,[contenteditable=true]')) return
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); void create('note', centerWorld()) }
      if (event.key.toLowerCase() === 't') { event.preventDefault(); void create('task', centerWorld()) }
      if (event.key.toLowerCase() === 'f') { event.preventDefault(); fit(snapshot, surface.current, setViewport) }
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [snapshot, repo, isVisible, selectedId])
  useEffect(() => {
    if (!isVisible) return
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (!target.closest('.kb-search-wrap')) setSearchOpen(false)
      if (!target.closest('.kb-filter-wrap')) setFilterOpen(false)
      if (!target.closest('.kb-trash, .kb-filter-wrap')) setShowTrash(false)
      if (selectedId && !target.closest(`[data-note-id="${selectedId}"]`)) {
        const commit = beforeSwitch.current
        void (commit ? commit() : Promise.resolve(true)).then(ok => { if (ok) closeNote(selectedId, false) })
      }
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [selectedId, isVisible])
  const loadTrash = async () => { setShowTrash(true); try { setTrash(await bridge.invoke<BoardNote[]>('board:query', { repo, query: { type: 'trash' } satisfies BoardQuery })) } catch (error) { onError((error as Error).message) } }
  const menuAction = async (action: string) => {
    const current = menu; setMenu(null)
    if (!current) return
    if (action.startsWith('create:')) return create(action.slice(7) as NoteKind | 'section', current.world)
    if (current.target) {
      const note = snapshot.notes.find(item => item.id === current.target)
      if (!note) return
      if (action === 'open') focusNote(note)
      if (action === 'delete') { await apply({ type: 'trashNote', id: note.id, expectedRevision: note.revision }); closeNote(note.id) }
      if (action === 'duplicate') { const copy = await apply({ type: 'createNote', note: { kind: note.kind, title: `${note.title} copy`, body: note.body }, position: { x: current.world.x + 20, y: current.world.y + 20 } }) as BoardNote | null; if (copy) openNote(copy.id) }
    } else if (current.section) {
      const section = sections.find(s => s.id === current.section)
      if (!section) return
      if (action === 'rename') { setRenamingSection(section.id); setSectionName(section.title) }
      if (action === 'collapse') await apply({ type: 'updateSection', id: section.id, patch: { collapsed: !section.collapsed } })
      if (action === 'deleteKeep') await apply({ type: 'deleteSection', id: section.id, keepNotes: true })
      if (action === 'deleteAll') await apply({ type: 'deleteSection', id: section.id, keepNotes: false })
    }
  }

  return <section className="knowledge-board" style={isVisible ? undefined : { display: 'none' }} aria-label={`Tasks and knowledge for ${repo}`}>
    <header className="kb-toolbar">
      <div className="kb-capture-actions"><button className="kb-add" disabled={snapshot.readOnly} onClick={() => void create('note', centerWorld())}><Plus size={16} /> Note <kbd>N</kbd></button><button className="kb-task-add" disabled={snapshot.readOnly} onClick={() => void create('task', centerWorld())}><Plus size={15} /> Task</button><button className="kb-more-add" disabled={snapshot.readOnly} aria-label="More ways to add to canvas" title="Add codebase context or section" onClick={e => { const rect = e.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom + 7, world: centerWorld() }) }}><ChevronDown size={15} /></button></div>
      <div className="kb-tools"><span className="kb-storage" title={bridge.desktop ? `Board files: ${repo}/.agents-hub/notes/*.md · layout: ${repo}/.agents-hub/canvas.json` : 'Browser preview: board changes are stored in local browser storage'}><Folder size={13} />{bridge.desktop ? '.agents-hub' : 'Preview storage'}</span>
        <OrganizerPanel repo={repo} snapshot={snapshot} blocked={!!selectedId || !!capture || !!drag.current} onRefresh={refresh} onError={onError} onOrganizing={setOrganizing} />
        <div className="kb-search-wrap"><Search size={15} /><input ref={searchInput} value={search} onChange={e => { setSearch(e.target.value); setSearchOpen(true) }} onFocus={() => setSearchOpen(true)} placeholder="Search board" aria-label="Search all board notes" /><kbd>⌘ K</kbd>{search && <button aria-label="Clear search" onClick={() => setSearch('')}><X size={13} /></button>}
          {searchOpen && search.trim() && <div className="kb-search-results"><div className="kb-search-caption">{matches.length} matching notes · including offscreen</div>{matches.slice(0, 12).map(note => <button key={note.id} onClick={() => focusNote(note)}>{kindIcon(note.kind)}<span><strong>{note.title}</strong><small>{kindLabel[note.kind]}{note.status ? ` · ${statusLabel[note.status]}` : ''}</small></span><ArrowDownRight size={13} /></button>)}{!matches.length && <p>No matches. Try another subject or clear the filter.</p>}</div>}</div>
        <div className="kb-filter-wrap"><button className="kb-filter-trigger" aria-expanded={filterOpen} onClick={() => setFilterOpen(value => !value)}>{filter === 'all' ? 'All' : filter === 'context' ? 'Context' : filter === 'task' ? 'Tasks' : 'Notes'} <span>{filter === 'all' ? snapshot.notes.length : counts[filter]}</span><ChevronDown size={13} /></button>{filterOpen && <div className="kb-filter-popover"><div className="kb-filter-set">{([['all', 'All', snapshot.notes.length], ['task', 'Tasks', counts.task], ['context', 'Context', counts.context], ['note', 'Notes', counts.note]] as const).map(([value, label, count]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => { setFilter(value); setFilterOpen(false) }}>{label}<span>{count}</span></button>)}</div><div className="kb-filter-right"><button onClick={() => setShowDone(v => !v)}>{showDone ? 'Hide completed' : 'Show completed'}</button><button onClick={() => { setFilterOpen(false); void loadTrash() }}><Trash2 size={12} /> Trash</button></div></div>}</div>
        <button className="kb-tool-icon" title="Fit all notes (F)" aria-label="Fit all notes" onClick={() => fit(snapshot, surface.current, setViewport)}><Maximize2 size={16} /></button>
      </div>
    </header>
    {!!snapshot.errors.length && <div className="kb-warning" role="alert"><CircleHelp size={14} /><span>{snapshot.errors.slice(0, 2).join(' · ')}</span><button onClick={() => void refresh()}>Refresh</button></div>}
    {loadError && <div className="kb-warning" role="alert"><CircleHelp size={14} /><span>Could not load board: {loadError}</span><button onClick={() => void refresh().catch(error => setLoadError((error as Error).message))}>Retry</button></div>}
    <div className="kb-main" style={organizing ? { pointerEvents: 'none' } : undefined}><div className="kb-viewport" ref={surface} onWheel={onWheel} onPointerDown={event => { if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains('kb-world')) startDrag(event, 'pan') }} onDoubleClick={event => { if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains('kb-world')) void create('note', worldAt(event.clientX, event.clientY)) }} onContextMenu={event => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, world: worldAt(event.clientX, event.clientY) }) }}>
      <div className="kb-grid" style={{ backgroundPosition: `${viewport.x}px ${viewport.y}px`, backgroundSize: `${26 * viewport.zoom}px ${26 * viewport.zoom}px` }} />
      <div className="kb-world" style={{ transform: `translate(${viewport.x}px,${viewport.y}px) scale(${viewport.zoom})` }}>
        {sections.map(section => <div key={section.id} className={`kb-section${section.collapsed ? ' collapsed' : ''}`} style={{ left: section.x, top: section.y, width: section.width, height: section.collapsed ? 52 : section.height }} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, world: worldAt(event.clientX, event.clientY), section: section.id }) }}><div className="kb-section-head"><button className="kb-section-grip" aria-label={`Move ${section.title} section`} onPointerDown={event => startDrag(event, 'section', section.id)}><Grip size={14} /></button>{renamingSection === section.id ? <input autoFocus value={sectionName} onChange={event => setSectionName(event.target.value)} onBlur={() => { void apply({ type: 'updateSection', id: section.id, patch: { title: sectionName } }); setRenamingSection(null) }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setRenamingSection(null) }} /> : <button className="kb-section-title" onDoubleClick={() => { setRenamingSection(section.id); setSectionName(section.title) }} onClick={() => void apply({ type: 'updateSection', id: section.id, patch: { collapsed: !section.collapsed } })}>{section.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}{section.title}</button>}<span>{snapshot.notes.filter(n => n.sectionId === section.id).length}</span><button className="kb-section-menu" aria-label={`${section.title} actions`} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom, world: { x: section.x, y: section.y }, section: section.id }) }}><MoreHorizontal size={16} /></button></div>{!section.collapsed && <button className="kb-section-resize" aria-label={`Resize ${section.title} section`} onPointerDown={event => startDrag(event, 'resize', section.id)} />}</div>)}
        <svg className="kb-links" aria-hidden="true">{snapshot.notes.flatMap(note => note.links.map(link => { const target = snapshot.notes.find(item => item.id === link.to), from = positions[note.id], to = positions[link.to]; if (!target || !from || !to || sections.find(s => s.id === note.sectionId)?.collapsed || sections.find(s => s.id === target.sectionId)?.collapsed) return null; return <path key={`${note.id}:${link.to}`} d={linkCurve(from, to)} /> }))}{linkFrom && linkCursor && positions[linkFrom] && <path className="drawing" d={linkCurve(positions[linkFrom], linkCursor, true)} />}</svg>
        {rendered.map(note => {
          const pos = positions[note.id] ?? { x: 100, y: 100 }
          const section = sections.find(item => item.id === note.sectionId)
          if (section?.collapsed) return null
          const editing = selectedId === note.id
          const dimmed = !matchIds.has(note.id)
          return <article
            key={note.id}
            data-note-id={note.id}
            tabIndex={0}
            aria-label={`${kindLabel[note.kind]} ${note.title}; Shift and arrow keys move`}
            onKeyDown={event => {
              if (event.target !== event.currentTarget) return
              if (event.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && !snapshot.readOnly) {
                event.preventDefault(); event.stopPropagation()
                const delta = 24
                const next = { x: pos.x + (event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0), y: pos.y + (event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0) }
                setPositions(current => ({ ...current, [note.id]: next }))
                void apply({ type: 'moveNote', id: note.id, position: next, expectedRevision: note.revision })
              } else if (event.key === 'Enter') { event.preventDefault(); void openNote(note.id) }
            }}
            onClickCapture={event => {
              if (suppressOpen.current === note.id) { suppressOpen.current = null; event.preventDefault(); event.stopPropagation(); return }
              if (linkFrom && linkFrom !== note.id) { event.preventDefault(); event.stopPropagation(); void connectNotes(linkFrom, note.id) }
            }}
            className={`kb-card kind-${note.kind}${editing ? ' editing selected' : ''}${dimmed ? ' dimmed' : ''}${linkFrom && linkFrom !== note.id ? ' link-target' : ''}`}
            style={{ left: pos.x, top: pos.y, width: editing ? editorWidth : cardWidth, ...(editing ? { height: editorHeight, transform: `scale(${1 / viewport.zoom})` } : {}) }}
            onWheel={event => { if (editing) event.stopPropagation() }}
            onContextMenu={event => { event.stopPropagation(); if (!editing) { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, world: worldAt(event.clientX, event.clientY), target: note.id }) } }}
          >
            {editing ? <Inspector key={note.id} repo={repo} note={note} notes={snapshot.notes} sections={sections} sessions={sessions} focusTitle={focusTitleId === note.id} onClose={() => closeNote(note.id)} onDragStart={event => { if (!(event.target as HTMLElement).closest('button,input,select,textarea')) startDrag(event, 'note', note.id) }} apply={apply} onWork={onWork} onFocus={focusNote} onError={onError} registerSwitch={fn => { beforeSwitch.current = fn }} /> : <>
              <div className="kb-card-top" onPointerDown={event => { if (!(event.target as HTMLElement).closest('button,input,select,textarea')) startDrag(event, 'note', note.id) }}><span className="kb-card-kind">{kindIcon(note.kind)}{note.kind === 'context' ? 'CONTEXT' : note.kind.toUpperCase()}</span><div className="kb-card-controls"><button className="kb-card-link" aria-label={`Link ${note.title} to another note`} title="Drag to another note, or click then choose a note" disabled={snapshot.readOnly} onPointerDown={event => { event.preventDefault(); event.stopPropagation(); linkPointer.current = { from: note.id, x: event.clientX, y: event.clientY, moved: false }; setLinkFrom(note.id); setLinkCursor(worldAt(event.clientX, event.clientY)) }} onClick={event => event.stopPropagation()}><Link2 size={13} /></button></div></div>
              <button className="kb-card-open" onPointerDown={event => startDrag(event, 'note', note.id)} onClick={() => { setFocusTitleId(note.id); void openNote(note.id) }}><strong>{note.title}</strong>{note.body && <span>{note.body}</span>}</button>
              <div className="kb-card-foot"><span>{note.status ? <><i className={`kb-status status-${note.status}`} />{statusLabel[note.status]}</> : note.kind === 'context' ? 'CODEBASE CONTEXT' : 'NOTE'}</span><span>{date(note.updatedAt)}</span></div>
            </>}
          </article>
        })}
      </div>
      {!loading && !loadError && !snapshot.notes.length && <div className="kb-empty"><h3>No notes yet</h3><p>Write an idea. You can turn it into a task later.</p><div><button className="kb-add" disabled={snapshot.readOnly} onClick={() => void create('note', centerWorld())}><Plus size={15} /> Add note</button></div><small>N: note · double-click: note · right-click: more</small></div>}
      {capture && <QuickCapture key={`${capture.kind}:${capture.position.x}:${capture.position.y}`} capture={capture} onSave={text => saveCapture(capture, text)} onClose={() => setCapture(null)} />}
      <div className="kb-canvas-hint"><span>{linkFrom ? 'CHOOSE A NOTE TO LINK · ESC TO CANCEL' : 'DOUBLE-CLICK: NOTE · N: NOTE · T: TASK · DRAG: PAN'}</span></div>
      <div className="kb-zoom"><button aria-label="Zoom out" onClick={() => setViewport(v => ({ ...v, zoom: clamp(v.zoom - .15, .35, 1.8) }))}><Minus size={15} /></button><span>{Math.round(viewport.zoom * 100)}%</span><button aria-label="Zoom in" onClick={() => setViewport(v => ({ ...v, zoom: clamp(v.zoom + .15, .35, 1.8) }))}><Plus size={15} /></button><button aria-label="Fit canvas" onClick={() => fit(snapshot, surface.current, setViewport)}><Focus size={15} /></button></div>
    </div>
      {showTrash && <aside className="kb-trash"><header><div><h3>Trash</h3></div><button aria-label="Close trash" onClick={() => setShowTrash(false)}><X size={16} /></button></header>{trash.length ? trash.map(note => <div key={note.id}><strong>{note.title}</strong><span>{kindLabel[note.kind]}</span><button onClick={() => void apply({ type: 'restoreNote', id: note.id }).then(() => loadTrash())}>Restore</button></div>) : <p>No notes in trash.</p>}</aside>}
    </div>
    {menu && <div className="kb-menu-scrim" onPointerDown={() => setMenu(null)} onContextMenu={e => { e.preventDefault(); setMenu(null) }}><div className="kb-menu" style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 270) }} onPointerDown={event => event.stopPropagation()}><small>{menu.target ? 'NOTE ACTIONS' : menu.section ? 'SECTION ACTIONS' : 'CREATE ON CANVAS'}</small>{menu.target ? <><button onClick={() => void menuAction('open')}><CornerDownRight size={15} /> Open note</button><button onClick={() => void menuAction('duplicate')}><Layers3 size={15} /> Duplicate</button><button className="danger" onClick={() => void menuAction('delete')}><Trash2 size={15} /> Move to trash</button></> : menu.section ? <><button onClick={() => void menuAction('rename')}>Rename section</button><button onClick={() => void menuAction('collapse')}>Collapse or expand</button><button onClick={() => void menuAction('deleteKeep')}>Remove section, keep notes</button><button className="danger" onClick={() => void menuAction('deleteAll')}>Move section and notes to trash</button></> : <><button onClick={() => void menuAction('create:task')}><Check size={15} /> New task <kbd>T</kbd></button><button onClick={() => void menuAction('create:note')}><FileText size={15} /> New note <kbd>N</kbd></button><button onClick={() => void menuAction('create:context')}><BookOpen size={15} /> Codebase context</button><span className="kb-menu-line" /><button onClick={() => void menuAction('create:section')}><Layers3 size={15} /> New section</button></>}</div></div>}
  </section>
}

function QuickCapture({ capture, onSave, onClose }: { capture: Capture; onSave: (text: string) => Promise<boolean>; onClose: () => void }) {
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const textRef = useRef('')
  const savingRef = useRef(false)
  const root = useRef<HTMLDivElement>(null)
  const save = useCallback(async () => {
    if (savingRef.current) return
    if (!textRef.current.trim()) { onClose(); return }
    savingRef.current = true; setSaving(true)
    const done = await onSave(textRef.current)
    if (!done) { savingRef.current = false; setSaving(false) }
  }, [onSave, onClose])
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) void save() }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [save])
  return <div ref={root} className={`kb-quick-capture kind-${capture.kind}`} style={{ left: capture.x, top: capture.y }} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}>
    <div className="kb-quick-head"><span>{kindIcon(capture.kind)} {kindLabel[capture.kind]}</span><button aria-label="Discard draft" title="Discard draft" onClick={onClose}><X size={14} /></button></div>
    <textarea autoFocus value={text} onChange={event => { textRef.current = event.target.value; setText(event.target.value) }} onKeyDown={event => { event.stopPropagation(); if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void save() } if (event.key === 'Escape') { event.preventDefault(); void save() } }} placeholder={capture.kind === 'task' ? 'What needs doing?' : capture.kind === 'context' ? 'What did you learn?' : 'Write an idea…'} aria-label={`New ${kindLabel[capture.kind].toLowerCase()}`} />
    <div className="kb-quick-foot"><span>First line becomes the title</span><button disabled={saving || !text.trim()} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'} <kbd>⌘ ↵</kbd></button></div>
  </div>
}

function fit(snapshot: BoardSnapshot, element: HTMLDivElement | null, setViewport: (value: Viewport) => void) {
  if (!element) return
  const rect = element.getBoundingClientRect(), bounds: Array<{ x: number; y: number; width: number; height: number }> = []
  for (const section of snapshot.sections) bounds.push(section)
  for (const note of snapshot.notes) { const p = snapshot.positions[note.id]; if (p) bounds.push({ ...p, width: cardWidth, height: cardHeight }) }
  if (!bounds.length) { setViewport({ x: rect.width / 2 - 100, y: rect.height / 2 - 100, zoom: 1 }); return }
  const minX = Math.min(...bounds.map(b => b.x)), minY = Math.min(...bounds.map(b => b.y)), maxX = Math.max(...bounds.map(b => b.x + b.width)), maxY = Math.max(...bounds.map(b => b.y + b.height))
  const zoom = clamp(Math.min((rect.width - 110) / Math.max(1, maxX - minX), (rect.height - 110) / Math.max(1, maxY - minY)), .35, 1.15)
  setViewport({ x: rect.width / 2 - (minX + maxX) / 2 * zoom, y: rect.height / 2 - (minY + maxY) / 2 * zoom, zoom })
}

function Inspector({ repo, note, notes, sections, sessions, focusTitle, onClose, onDragStart, apply, onWork, onFocus, onError, registerSwitch }: { repo: string; note: BoardNote; notes: BoardNote[]; sections: BoardSection[]; sessions: RepoContext[]; focusTitle: boolean; onClose: () => void; onDragStart: (event: ReactPointerEvent) => void; apply: (command: BoardCommand) => Promise<unknown>; onWork: (sessionId: string, task: BoardNote) => void; onFocus: (note: BoardNote) => void; onError: (message: string) => void; registerSwitch: (fn: (() => Promise<boolean>) | null) => void }) {
  const [draft, setDraft] = useState(note)
  const draftRef = useRef(note)
  const savedRef = useRef(note)
  const saveRef = useRef<() => Promise<BoardNote | null>>(async () => null)
  const savingRef = useRef<Promise<BoardNote | null> | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [savedRevision, setSavedRevision] = useState(note.revision)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [preview, setPreview] = useState(false)
  const [learning, setLearning] = useState(false)
  const [learningTitle, setLearningTitle] = useState('')
  const [learningSubject, setLearningSubject] = useState('')
  const [learningBody, setLearningBody] = useState('')
  const [evidence, setEvidence] = useState('')
  const [learningTarget, setLearningTarget] = useState('')
  const [noLearning, setNoLearning] = useState('')
  const [history, setHistory] = useState<Array<{ revision: string; note: BoardNote }> | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const bodyInput = useRef<HTMLTextAreaElement>(null)
  const [dictationState, setDictationState] = useState<'idle' | 'starting' | 'recording' | 'processing' | 'ready'>('idle')
  const [transcript, setTranscript] = useState('')
  const startDictation = async () => {
    setDictationState('starting')
    try { await bridge.invoke('dictation:start'); setDictationState('recording') }
    catch (error) { setDictationState('idle'); onError((error as Error).message) }
  }
  const stopDictation = async () => {
    setDictationState('processing')
    try { const text = await bridge.invoke<string>('dictation:stop'); setTranscript(text); setDictationState('ready') }
    catch (error) { setDictationState('idle'); onError((error as Error).message) }
  }
  const cancelDictation = () => { void bridge.invoke('dictation:cancel').catch(() => {}); setTranscript(''); setDictationState('idle') }
  const insertTranscript = () => {
    const spoken = transcript.trim()
    if (spoken) {
      const start = bodyInput.current?.selectionStart ?? draftRef.current.body.length
      const end = bodyInput.current?.selectionEnd ?? start
      edit(current => ({ ...current, body: `${current.body.slice(0, start)}${current.body && start > 0 && !/\s$/.test(current.body.slice(0, start)) ? ' ' : ''}${spoken}${current.body.slice(end)}` }))
    }
    setTranscript(''); setDictationState('idle'); bodyInput.current?.focus()
  }
  useEffect(() => () => { void bridge.invoke('dictation:cancel').catch(() => {}) }, [])
  const [imagePreviews, setImagePreviews] = useState<Record<string, string>>({})
  useEffect(() => {
    let active = true
    for (const image of note.images ?? []) {
      if (imagePreviews[image.id]) continue
      void bridge.invoke<string>('board:image:preview', { repo, id: image.id }).then(preview => { if (active) setImagePreviews(current => ({ ...current, [image.id]: preview })) }).catch(() => {})
    }
    return () => { active = false }
  }, [repo, note.images])
  const addImages = async (files: File[]) => {
    for (const file of files) {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 20 * 1024 * 1024) { onError('Choose a PNG, JPEG, WebP, or GIF image under 20 MB.'); continue }
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Could not read image.')); reader.readAsDataURL(file) })
        const image = await bridge.invoke<import('../shared/board').BoardImage>('board:image:add', { repo, name: file.name, mime: file.type, base64: dataUrl.split(',')[1] })
        setImagePreviews(current => ({ ...current, [image.id]: dataUrl }))
        edit(current => ({ ...current, images: [...(current.images ?? []), image] }))
      } catch (error) { onError((error as Error).message) }
    }
  }
  const fields = ['kind', 'title', 'body', 'sectionId', 'links', 'status', 'acceptance', 'sessionId', 'agent', 'outcome', 'subject', 'evidence', 'images'] as (keyof BoardNote)[]
  const changed = (a: BoardNote, b: BoardNote) => fields.some(key => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
  const edit = (update: (current: BoardNote) => BoardNote) => setDraft(current => { const next = update(current); draftRef.current = next; return next })
  const replaceDraft = (next: BoardNote) => { draftRef.current = next; setDraft(next) }
  useEffect(() => { if (focusTitle) { titleRef.current?.focus(); titleRef.current?.select() } }, [focusTitle])
  const stale = note.revision !== savedRevision && !savingRef.current
  const dirty = changed(draft, savedRef.current)
  const related = notes.filter(item => draft.links.some(link => link.to === item.id) || item.links.some(link => link.to === note.id))
  const save = async (): Promise<BoardNote | null> => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    if (savingRef.current) return savingRef.current
    const run = async (): Promise<BoardNote | null> => {
      let last: BoardNote | null = savedRef.current
      while (changed(draftRef.current, savedRef.current)) {
        const current = draftRef.current
        const base = savedRef.current
        setSaveState('saving')
        const patch: Partial<BoardNote> = { kind: current.kind, title: current.title, body: current.body, sectionId: current.sectionId, links: current.links, images: current.images, updatedBy: 'person', ...(current.kind === 'task' ? { status: current.status, acceptance: current.acceptance, sessionId: current.sessionId, agent: current.agent, outcome: current.outcome } : {}), ...(current.kind === 'context' ? { subject: current.subject, evidence: current.evidence } : {}) }
        let updated = await apply({ type: 'updateNote', id: note.id, patch, expectedRevision: base.revision }) as BoardNote | null
        if (!updated) { setSaveState('error'); return null }
        if (updated.sectionId && updated.sectionId !== base.sectionId) {
          const section = sections.find(item => item.id === updated!.sectionId)
          if (section) {
            const count = notes.filter(item => item.sectionId === section.id && item.id !== note.id).length
            updated = await apply({ type: 'moveNote', id: updated.id, expectedRevision: updated.revision, sectionId: section.id, position: { x: section.x + 24 + (count % 2) * 275, y: section.y + 56 + Math.floor(count / 2) * 194 } }) as BoardNote | null
            if (!updated) { setSaveState('error'); return null }
          }
        }
        savedRef.current = updated
        setSavedRevision(updated.revision)
        last = updated
        if (draftRef.current === current) replaceDraft(updated)
      }
      setSaveState('saved')
      return last
    }
    const pending = run()
    savingRef.current = pending
    try { return await pending } finally { savingRef.current = null }
  }
  saveRef.current = save
  useEffect(() => { registerSwitch(async () => !changed(draftRef.current, savedRef.current) || !!await saveRef.current()); return () => registerSwitch(null) }, [])
  useEffect(() => {
    if (note.revision !== savedRef.current.revision && !savingRef.current && !changed(draftRef.current, savedRef.current)) {
      savedRef.current = note; setSavedRevision(note.revision); replaceDraft(note); setSaveState('saved')
    }
  }, [note.revision])
  useEffect(() => {
    if (!dirty || stale || !draft.title.trim()) return
    saveTimer.current = setTimeout(() => { void saveRef.current() }, 450)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [draft, stale])
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); if (changed(draftRef.current, savedRef.current)) void saveRef.current() }, [])
  const close = async () => { if (!dirty || await save()) onClose() }
  const unlink = async (item: BoardNote) => {
    const owner = note.links.some(link => link.to === item.id) ? note : item
    const to = owner.id === note.id ? item.id : note.id
    const updated = await apply({ type: 'updateNote', id: owner.id, expectedRevision: owner.revision, patch: { links: owner.links.filter(link => link.to !== to), updatedBy: 'person' } }) as BoardNote | null
    if (updated && owner.id === note.id) { savedRef.current = updated; edit(current => ({ ...current, links: updated.links })); setSavedRevision(updated.revision) }
  }
  const work = async () => {
    if (!draft.sessionId) { onError('Choose a Session for this task.'); return }
    if (stale) { onError('This task changed on disk. Reload it before starting work.'); return }
    const saved = await save()
    if (!saved) return
    const working = saved.status === 'working' ? saved : await apply({ type: 'updateNote', id: saved.id, expectedRevision: saved.revision, patch: { status: 'working', updatedBy: 'person' } }) as BoardNote | null
    if (working) onWork(draft.sessionId, working)
  }
  const complete = async () => {
    const hasLearning = !!learningBody.trim()
    if (hasLearning && (!learningTitle.trim() || !learningSubject.trim() || !evidence.trim())) { onError('A learning needs a title, subject, and evidence path.'); return }
    if (!hasLearning && !noLearning.trim()) { onError('Add a durable learning or explain why there is none.'); return }
    if (stale) { onError('This task changed on disk. Reload it before completing.'); return }
    const saved = await save()
    if (!saved) return
    const target = notes.find(n => n.id === learningTarget)
    const updated = await apply({ type: 'completeTask', id: note.id, expectedRevision: saved.revision, outcome: saved.outcome?.trim() || saved.body.trim() || 'Task completed.', acceptance: saved.acceptance ?? [], actor: 'person', operationId: crypto.randomUUID(), contextChanges: hasLearning ? [{ ...(target ? { id: target.id, expectedRevision: target.revision } : {}), title: learningTitle.trim(), subject: learningSubject.trim(), body: learningBody.trim(), evidence: evidence.split('\n').map(path => ({ path: path.trim() })).filter(item => item.path) }] : [], noLearningReason: noLearning.trim() }) as BoardNote | null
    if (updated) { savedRef.current = updated; replaceDraft(updated); setSavedRevision(updated.revision); setLearning(false) }
  }
  const openHistory = async () => { try { setHistory(await bridge.invoke<Array<{ revision: string; note: BoardNote }>>('board:query', { repo, query: { type: 'history', id: note.id } })) } catch (error) { onError((error as Error).message) } }
  return <div className="kb-inspector" aria-label={`${kindLabel[note.kind]} editor`} onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.some(file => file.type.startsWith('image/'))) { event.preventDefault(); void addImages(files) } }} onDragOver={event => { if (Array.from(event.dataTransfer.items).some(item => item.kind === 'file')) event.preventDefault() }} onDrop={event => { const files = Array.from(event.dataTransfer.files); if (files.length) { event.preventDefault(); void addImages(files) } }}><div className="kb-inspector-top" onPointerDown={onDragStart}><span className="kb-eyebrow">{kindIcon(draft.kind)} {kindLabel[draft.kind].toUpperCase()} <span className="kb-inspector-id">/ {note.id}</span></span><button aria-label="Close note" title="Close note" onClick={() => void close()}><X size={17} /></button></div>
    {stale && <div className="kb-inspector-stale">This note changed outside the editor. Your draft is preserved. <button onClick={() => { replaceDraft(note); savedRef.current = note; setSavedRevision(note.revision); setSaveState('saved') }}>Reload latest</button><button onClick={() => void navigator.clipboard.writeText(draft.body).catch(() => onError('Could not copy the draft.'))}>Copy draft</button></div>}
    <div className="kb-inspector-scroll"><label className="kb-inspector-title"><span>Title</span><input ref={titleRef} value={draft.title} onChange={e => edit(d => ({ ...d, title: e.target.value }))} maxLength={160} /></label>
      <div className="kb-inspector-meta"><label>Type<select value={draft.kind} onChange={e => edit(d => ({ ...d, kind: e.target.value as NoteKind }))}><option value="task">Task</option><option value="context">Codebase context</option><option value="note">Note</option></select></label>{draft.kind === 'task' && <label>Status<select value={draft.status ?? 'open'} onChange={e => edit(d => ({ ...d, status: e.target.value as TaskState }))}>{(['open', 'working', 'blocked', ...(draft.status === 'done' ? ['done'] : [])] as TaskState[]).map(value => <option key={value} value={value}>{statusLabel[value]}</option>)}</select></label>}</div>
      <label className="kb-field">Section<select value={draft.sectionId} onChange={e => edit(d => ({ ...d, sectionId: e.target.value }))}><option value="">No section</option>{sections.map(section => <option key={section.id} value={section.id}>{section.title}</option>)}</select></label>
      <div className="kb-body-label"><label htmlFor="kb-body">{draft.kind === 'task' ? 'Brief' : draft.kind === 'context' ? 'What we know' : 'Thoughts'}</label><button onClick={() => setPreview(v => !v)}>{preview ? 'Edit' : 'Preview'}</button></div>{preview ? <div className="kb-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{draft.body || '*Nothing written yet.*'}</ReactMarkdown></div> : <textarea ref={bodyInput} id="kb-body" className="kb-body" value={draft.body} onChange={e => edit(d => ({ ...d, body: e.target.value }))} placeholder={draft.kind === 'task' ? 'What needs to change? What would success look like?' : draft.kind === 'context' ? 'A concise, evidence-backed fact about this repository…' : 'A question, hypothesis, observation, or idea…'} />}
      <div className="kb-dictation"><button type="button" disabled={!bridge.desktop || dictationState === 'starting' || dictationState === 'processing' || dictationState === 'ready'} onClick={() => dictationState === 'recording' ? void stopDictation() : void startDictation()}><Mic size={14} />{dictationState === 'recording' ? 'Stop recording' : dictationState === 'starting' ? 'Starting microphone…' : dictationState === 'processing' ? 'Transcribing…' : 'Dictate note'}</button>{dictationState === 'recording' && <span className="kb-recording">Recording on this Mac</span>}{dictationState === 'ready' && <div className="kb-transcript"><textarea aria-label="Dictation transcript" value={transcript} onChange={event => setTranscript(event.target.value)} placeholder="No speech was detected" /><div><button type="button" onClick={cancelDictation}>Discard</button><button type="button" onClick={insertTranscript} disabled={!transcript.trim()}>Insert transcript</button></div></div>}{!bridge.desktop && <small>Dictation is available in the desktop app.</small>}</div>
      <div className="kb-image-section"><div><span>Images</span><button type="button" onClick={() => imageInput.current?.click()}><ImagePlus size={14} /> Add image</button><input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={event => { void addImages(Array.from(event.target.files ?? [])); event.target.value = '' }} /></div>{(draft.images ?? []).map(image => <div className="kb-image-row" key={image.id}>{imagePreviews[image.id] ? <img src={imagePreviews[image.id]} alt={image.description || image.name} /> : <div className="kb-image-missing">Preview unavailable</div>}<div><strong>{image.name}</strong><input aria-label={`Description for ${image.name}`} value={image.description ?? ''} placeholder="Describe this image for the agent" onChange={event => edit(current => ({ ...current, images: (current.images ?? []).map(item => item.id === image.id ? { ...item, description: event.target.value } : item) }))} /></div><button type="button" aria-label={`Remove ${image.name}`} onClick={() => edit(current => ({ ...current, images: (current.images ?? []).filter(item => item.id !== image.id) }))}><X size={14} /></button></div>)}</div>
      {draft.kind === 'task' && <><label className="kb-field">Acceptance checks<textarea rows={3} value={(draft.acceptance ?? []).join('\n')} onChange={e => edit(d => ({ ...d, acceptance: e.target.value.split('\n') }))} placeholder="One observable check per line" /></label><div className="kb-inspector-meta"><label>Session<select value={draft.sessionId ?? ''} onChange={e => edit(d => ({ ...d, sessionId: e.target.value }))}><option value="">No Session</option>{sessions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>Agent<input value={draft.agent ?? ''} onChange={e => edit(d => ({ ...d, agent: e.target.value }))} placeholder="Optional" /></label></div><label className="kb-field">Outcome<textarea rows={3} value={draft.outcome ?? ''} onChange={e => edit(d => ({ ...d, outcome: e.target.value }))} placeholder="What changed? What did we verify?" /></label>{draft.status === 'done' && <div className={`kb-capture capture-${draft.captureState}`}>{draft.captureState === 'captured' ? 'Knowledge captured in codebase context' : draft.captureState === 'none' ? 'Completed with no durable learning' : draft.captureState === 'legacy_unknown' ? 'Imported completed task · historical learning unknown' : 'Knowledge capture pending'}</div>}</>}
      {draft.kind === 'context' && <><label className="kb-field">Subject<input value={draft.subject ?? ''} onChange={e => edit(d => ({ ...d, subject: e.target.value }))} placeholder="e.g. authentication persistence" /></label><label className="kb-field">Evidence paths<textarea rows={3} value={(draft.evidence ?? []).map(item => item.path).join('\n')} onChange={e => edit(d => ({ ...d, evidence: e.target.value.split('\n').map(path => ({ path: path.trim() })).filter(item => item.path) }))} placeholder="server/auth.ts" /></label></>}
      <div className="kb-related"><div><span className="kb-eyebrow">LINKED NOTES</span><span>{related.length}</span></div>{related.map(item => <div className="kb-related-row" key={item.id}><button onClick={() => onFocus(item)}>{kindIcon(item.kind)}<span>{item.title}</span><ChevronRight size={13} /></button><button className="kb-unlink" aria-label={`Unlink ${item.title}`} title="Remove link" onClick={() => void unlink(item)}><X size={13} /></button></div>)}<p>On the canvas, drag the link handle from one note to another. You can also click the handle, then click the destination.</p></div>
      {history && <div className="kb-history"><span className="kb-eyebrow">PREVIOUS VERSIONS</span>{history.map(item => <button key={item.revision} onClick={() => { replaceDraft({ ...item.note, revision: savedRevision }); setHistory(null) }}>{date(item.note.updatedAt)} · {item.note.title}</button>)}{!history.length && <p>No earlier versions yet.</p>}</div>}
      {draft.kind === 'task' && learning && <div className="kb-learning"><div className="kb-learning-head"><BookOpen size={16} /><span>Codebase context</span></div><p>Record a fact another Session should be able to retrieve.</p><label>Update existing context<select value={learningTarget} onChange={e => { const id = e.target.value; setLearningTarget(id); const target = notes.find(n => n.id === id); if (target) { setLearningTitle(target.title); setLearningSubject(target.subject ?? ''); setLearningBody(target.body); setEvidence((target.evidence ?? []).map(x => x.path).join('\n')) } }}><option value="">Create new context note</option>{notes.filter(n => n.kind === 'context').map(n => <option key={n.id} value={n.id}>{n.title}</option>)}</select></label><label>Title<input value={learningTitle} onChange={e => setLearningTitle(e.target.value)} placeholder="Specific codebase fact" /></label><label>Subject<input value={learningSubject} onChange={e => setLearningSubject(e.target.value)} placeholder="e.g. database migrations" /></label><label>Concise fact<textarea rows={4} value={learningBody} onChange={e => setLearningBody(e.target.value)} placeholder="What did the code or tests prove?" /></label><label>Evidence paths<textarea rows={2} value={evidence} onChange={e => setEvidence(e.target.value)} placeholder="One file path per line" /></label><div className="kb-learning-or">or</div><label>No durable learning<input value={noLearning} onChange={e => setNoLearning(e.target.value)} placeholder="Why nothing needs to be saved" /></label><div className="kb-learning-actions"><button onClick={() => setLearning(false)}>Cancel</button><button className="kb-action" onClick={() => void complete()}>Complete task</button></div></div>}
    </div><footer className="kb-inspector-actions"><button title="View history" aria-label="View note history" onClick={() => void openHistory()}><History size={16} /></button>{draft.kind === 'task' && !learning && <button className="kb-work" onClick={() => void work()}><Command size={14} /> Work in Session</button>}{draft.kind === 'task' && !learning && <button className="kb-work" onClick={() => setLearning(true)}><Check size={14} /> Complete</button>}<span className={`kb-save-status state-${saveState}`} role="status">{stale ? 'Changed elsewhere' : saveState === 'error' ? 'Save failed' : dirty || saveState === 'saving' ? 'Saving…' : 'Saved'}</span>{saveState === 'error' && <button onClick={() => void save()}>Retry</button>}</footer>
  </div>
}
