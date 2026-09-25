import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Folder, FolderOpen, Loader2, Plus, RefreshCw, Search, X } from 'lucide-react'
import { bridge } from './bridge'
/** A folder that belongs to a project, marked in the tree. */
export interface MarkedFolder { path: string; color: string; running: boolean }

interface DirEntry { name: string; path: string }
interface DirListing { path: string; home: string; entries: DirEntry[] }
interface NodeState { entries?: DirEntry[]; error?: string; loading?: boolean }

const under = (path: string, root: string) => path === root || path.startsWith(root === '/' ? '/' : `${root}/`)
const baseOf = (path: string) => (path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1))

/** Filesystem browser. The tree roots at home (plus any project folder
 *  outside it); a dot in the project's colour marks project folders, and
 *  breathes while any of that project's terminals runs. */
export default function FolderBrowser({ selected, marked, onSelect, onError }: {
  selected: string
  marked: MarkedFolder[]
  onSelect: (path: string) => void
  onError: (message: string) => void
}) {
  const [home, setHome] = useState<string | null>(null)
  const [nodes, setNodes] = useState<Record<string, NodeState>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const autoExpanded = useRef<Set<string>>(new Set())
  const dots = useMemo(() => new Map(marked.map(item => [item.path, item])), [marked])
  // Extra roots for context folders outside home, minimized so none nests
  // under another. The selected folder is always reachable this way.
  const roots = useMemo(() => {
    if (!home) return []
    const outside = [...new Set([selected, ...dots.keys()].filter(p => p && !under(p, home)))]
    const minimal = outside.filter(p => !outside.some(o => o !== p && under(p, o)))
    return [home, ...minimal]
  }, [home, selected, dots])
  useEffect(() => {
    setExpanded(prev => {
      const next = { ...prev }
      for (const root of roots) {
        if (!autoExpanded.current.has(root)) { autoExpanded.current.add(root); next[root] = true }
      }
      return next
    })
  }, [roots])

  const load = async (path: string): Promise<DirEntry[] | null> => {
    setNodes(prev => ({ ...prev, [path]: { ...prev[path], loading: true, error: undefined } }))
    try {
      const listing = await bridge.invoke<DirListing>('listDir', { path })
      if (!home) setHome(listing.home)
      setNodes(prev => ({ ...prev, [listing.path]: { entries: listing.entries } }))
      return listing.entries
    } catch (e) {
      setNodes(prev => ({ ...prev, [path]: { error: (e as Error).message } }))
      return null
    }
  }
  const toggle = (path: string) => {
    if (expanded[path]) {
      setExpanded(prev => {
        const next = { ...prev }
        delete next[path]
        return next
      })
      return
    }
    setExpanded(prev => ({ ...prev, [path]: true }))
    const node = nodes[path]
    if (!node?.entries && !node?.loading) void load(path).catch(e => onError((e as Error).message))
  }
  const reveal = async (target: string) => {
    if (!home || !target) return
    const root = roots.find(r => under(target, r))
    if (!root) return
    // Expand the ancestor chain level by level, loading as needed.
    const chain: string[] = [root]
    if (target !== root) {
      const rest = target.slice(root === '/' ? 1 : root.length + 1).split('/')
      let prefix = root
      for (const segment of rest) {
        prefix = prefix === '/' ? `/${segment}` : `${prefix}/${segment}`
        chain.push(prefix)
      }
    }
    // Expand ancestors only: selecting a folder opens its context pane but
    // must never force its own contents open.
    for (const prefix of chain.slice(0, -1)) {
      setExpanded(prev => (prev[prefix] ? prev : { ...prev, [prefix]: true }))
      if (!nodes[prefix]?.entries && !nodes[prefix]?.loading) await load(prefix)
    }
    requestAnimationFrame(() => {
      document.querySelector(`[data-folder="${CSS.escape(target)}"]`)?.scrollIntoView({ block: 'nearest' })
    })
  }
  useEffect(() => {
    let live = true
    bridge.invoke<DirListing>('listDir', {}).then(listing => {
      if (!live) return
      setHome(listing.home)
      setNodes(prev => ({ ...prev, [listing.path]: { entries: listing.entries } }))
    }).catch(e => { if (live) onError((e as Error).message) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => { void reveal(selected) }, [selected, home]) // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = async () => {
    setRefreshing(true)
    try {
      const loaded = Object.keys(nodes).filter(p => nodes[p].entries)
      await Promise.all([home, ...loaded].filter(Boolean).map(p => load(p as string)))
    } finally { setRefreshing(false) }
  }

  const query = search.trim().toLowerCase()
  const results = useMemo(() => {
    if (!query) return []
    const seen = new Set<string>()
    const matches: { path: string; context: boolean }[] = []
    const consider = (path: string, context: boolean) => {
      if (seen.has(path) || !baseOf(path).toLowerCase().includes(query)) return
      seen.add(path)
      matches.push({ path, context })
    }
    for (const path of dots.keys()) consider(path, true)
    for (const node of Object.values(nodes)) for (const e of node.entries ?? []) consider(e.path, dots.has(e.path))
    matches.sort((a, b) => Number(b.context) - Number(a.context) || a.path.localeCompare(b.path))
    return matches
  }, [query, dots, nodes])
  const pickResult = (path: string) => {
    setSearch('')
    onSelect(path)
  }

  const crumbs = useMemo(() => {
    if (!selected) return []
    const parts = selected.split('/').filter(Boolean)
    const chain: { label: string; path: string }[] = [{ label: '/', path: '/' }]
    let prefix = ''
    for (const part of parts) {
      prefix += `/${part}`
      chain.push({ label: part, path: prefix })
    }
    return chain
  }, [selected])

  const renderNode = (path: string, name: string, depth: number): ReactNode => {
    const node = nodes[path]
    const isOpen = !!expanded[path]
    const info = dots.get(path)
    const knownEmpty = node?.entries !== undefined && node.entries.length === 0 && !node.error
    const dotTitle = info ? `In a project${info.running ? ' · running' : ''}` : ''
    return (
      <div key={path}>
        <div
          data-folder={path}
          role="treeitem"
          aria-selected={path === selected}
          aria-expanded={node?.entries ? isOpen : undefined}
          className={`folder-row${path === selected ? ' active' : ''}`}
          style={{ paddingLeft: 8 + depth * 16 }}
          title={info ? `${path} · ${dotTitle}` : path}
          onClick={() => onSelect(path)}
          onDoubleClick={() => toggle(path)}
        >
          {node?.loading ? <Loader2 size={13} className="spin folder-chevron" /> : knownEmpty ? <span className="folder-chevron" /> : (
            <button aria-label={isOpen ? `Collapse ${name}` : `Expand ${name}`} className={`icon-button folder-chevron${isOpen ? ' open' : ''}`} onClick={e => { e.stopPropagation(); toggle(path) }}>
              <ChevronRight size={14} />
            </button>
          )}
          {isOpen ? <FolderOpen size={15} /> : <Folder size={15} />}
          <span className="folder-name">{name}</span>
          {info && <span className={`context-dot${info.running ? ' running' : ''}`} title={dotTitle} style={{ background: info.color }} />}
        </div>
        {isOpen && node?.entries?.map(e => renderNode(e.path, e.name, depth + 1))}
        {isOpen && node?.error && !node.loading && (
          <button className="folder-error" style={{ paddingLeft: 8 + (depth + 1) * 16 }} title={node.error} onClick={() => void load(path)}>
            Can&apos;t read folder · retry
          </button>
        )}
      </div>
    )
  }

  return (
    <>
      <label className="search">
        <Search size={14} />
        <input aria-label="Search folders" placeholder="Search folders" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && results[0]) pickResult(results[0].path) }} />
        {search && <button aria-label="Clear search" onClick={() => setSearch('')}><X size={12} /></button>}
      </label>
      <div className="sidebar-scroll" role={query ? undefined : 'tree'} aria-label="Folders">
        {query ? (
          results.length ? results.map(r => (
            <button key={r.path} className={`folder-row result${r.path === selected ? ' active' : ''}`} onClick={() => pickResult(r.path)} title={r.path}>
              <Folder size={15} />
              <span className="folder-name">{baseOf(r.path)}</span>
              {(() => { const info = dots.get(r.path); return info ? <span className={`context-dot${info.running ? ' running' : ''}`} style={{ background: info.color }} /> : null })()}
              <small>{r.path.slice(0, r.path.length - baseOf(r.path).length - 1) || '/'}</small>
            </button>
          )) : <p className="sidebar-empty">No matching folders.</p>
        ) : (
          <>
            <div className="breadcrumb" aria-label="Current folder">
              {crumbs.map((c, i) => (
                <span key={c.path} className="crumb">
                  {i > 0 && <span className="crumb-sep">/</span>}
                  <button className={c.path === selected ? 'current' : undefined} onClick={() => onSelect(c.path)} title={c.path}>{c.label}</button>
                </span>
              ))}
            </div>
            <div className="section-label">
              <span>Folders</span>
              <button aria-label="Refresh folders" title="Refresh folders" className="icon-button" disabled={refreshing} onClick={() => void refresh().catch(e => onError((e as Error).message))}>
                <RefreshCw size={13} className={refreshing ? 'spin' : undefined} />
              </button>
            </div>
            {!home && !nodes['/'] ? <p className="sidebar-empty">Loading folders…</p> : roots.map(r => renderNode(r, r === '/' ? '/' : baseOf(r), 0))}
          </>
        )}
      </div>
    </>
  )
}
