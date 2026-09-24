import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BookOpen, Check, FileText, Search, Terminal, Zap } from 'lucide-react'
import { bridge } from './bridge'
import { terminalState, terminalStatus } from './agentState'
import type { TerminalResource } from './types'
import type { BoardNote } from '../shared/board'
import { fuzzyScore } from './fuzzy'

export interface PaletteAction { id: string; label: string; hint?: string; keywords?: string; run: () => void }
type Item = { key: string; group: string; label: string; detail?: string; icon: ReactNode; run: () => void; text: string }

const noteIcon = (note: BoardNote) => note.kind === 'task' ? <Check size={14} /> : note.kind === 'context' ? <BookOpen size={14} /> : <FileText size={14} />

/** ⌘K: jump to any note or agent, or run an action, from anywhere in the app. */
export default function CommandPalette({ repo, terminals, actions, onNote, onTerminal, onClose }: {
  repo: string; terminals: TerminalResource[]; actions: PaletteAction[]
  onNote: (note: BoardNote) => void; onTerminal: (terminal: TerminalResource) => void; onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [notes, setNotes] = useState<BoardNote[]>([])
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => {
    let live = true
    bridge.invoke<BoardNote[]>('board:query', { repo, query: { type: 'search', limit: 100 } })
      .then(result => { if (live) setNotes(result) }).catch(() => { if (live) setNotes([]) })
    return () => { live = false }
  }, [repo])
  const items = useMemo(() => {
    const all: Item[] = [
      ...terminals.map(terminal => ({ key: `t:${terminal.id}`, group: 'Agents', label: terminal.name, detail: terminalStatus(terminal), text: `${terminal.name} ${terminal.agent}`,
        icon: <span className={`status-dot state-${terminalState(terminal)}`} />, run: () => onTerminal(terminal) })),
      ...[...notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(note => ({ key: `n:${note.id}`, group: note.question ? 'Questions' : 'Notes', label: note.title,
        detail: note.question ? note.question.text : note.status ?? (note.kind === 'context' ? 'context' : 'note'), text: `${note.title} ${note.body.slice(0, 400)} ${note.question?.text ?? ''} ${note.id}`,
        icon: noteIcon(note), run: () => onNote(note) })),
      ...actions.map(action => ({ key: `a:${action.id}`, group: 'Actions', label: action.label, detail: action.hint, text: `${action.label} ${action.keywords ?? ''}`, icon: <Zap size={14} />, run: action.run })),
    ]
    const q = query.trim()
    if (!q) {
      // Empty query: what needs you first, then agents, recent notes, actions.
      const order = ['Questions', 'Agents', 'Notes', 'Actions']
      return all.filter(item => item.group !== 'Notes' || all.filter(other => other.group === 'Notes').indexOf(item) < 6)
        .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group))
    }
    // Best matches first, kept together by group; a group ranks by its best match.
    const ranked = all.map(item => ({ item, score: fuzzyScore(q, item.label) * 2 + Math.max(0, fuzzyScore(q, item.text)) }))
      .filter(entry => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, 40)
    const groups = [...new Set(ranked.map(entry => entry.item.group))]
    return ranked.sort((a, b) => groups.indexOf(a.item.group) - groups.indexOf(b.item.group) || b.score - a.score).map(entry => entry.item)
  }, [terminals, notes, actions, query, onNote, onTerminal])
  useEffect(() => { setIndex(0) }, [query])
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' }) }, [index])
  const choose = (item?: Item) => { if (!item) return; onClose(); item.run() }
  let lastGroup = ''
  return <div className="palette-overlay" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <label className="palette-input"><Search size={16} /><input ref={input} value={query} placeholder="Jump to a note or agent, or run an action…" aria-label="Command palette search" aria-controls="palette-list"
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(value => Math.min(items.length - 1, value + 1)) }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(value => Math.max(0, value - 1)) }
          else if (event.key === 'Enter') { event.preventDefault(); choose(items[index]) }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
        }} /><kbd>esc</kbd></label>
      <div className="palette-list" id="palette-list" role="listbox" ref={list}>
        {items.map((item, position) => {
          const heading = item.group !== lastGroup ? item.group : ''
          lastGroup = item.group
          return <div key={item.key}>{heading && <div className="palette-group">{heading}</div>}
            <button role="option" aria-selected={position === index} data-index={position} className={position === index ? 'active' : ''} onMouseMove={() => setIndex(position)} onClick={() => choose(item)}>
              <span className="palette-icon">{item.icon}</span><span className="palette-label">{item.label}</span>{item.detail && <small>{item.detail}</small>}
            </button></div>
        })}
        {!items.length && <p className="palette-empty">Nothing matches “{query}”.</p>}
      </div>
      <footer className="palette-foot"><span><kbd>↑↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><Terminal size={11} /> <kbd>⌘J</kbd> terminal drawer</span></footer>
    </div>
  </div>
}
