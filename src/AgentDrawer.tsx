import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { Maximize2, X } from 'lucide-react'
import TerminalView from './TerminalView'
import { terminalState, terminalStatus } from './agentState'
import type { ThemeMode } from './theme'
import type { RepoContext, TerminalResource } from './types'

export const DRAWER_MIN = 360, DRAWER_MAX = 1100, DRAWER_DEFAULT = 520

/** A terminal docked beside the Tasks canvas, so an agent and its work are
 *  visible together. Any terminal in the repository can be shown here. */
export default function AgentDrawer({ terminal, sessions, width, onWidth, onSelect, onExpand, onClose, onError, patch, themeMode, themeBackground, themeAccent }: {
  terminal: TerminalResource; sessions: RepoContext[]; width: number
  onWidth: (width: number) => void; onSelect: (id: string) => void; onExpand: () => void; onClose: () => void
  onError: (message: string) => void; patch: (id: string, changes: Partial<TerminalResource>) => Promise<unknown>
  themeMode?: ThemeMode; themeBackground?: string; themeAccent?: string
}) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)
  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    drag.current = { startX: event.clientX, startWidth: width }
    const move = (next: PointerEvent) => { if (drag.current) onWidth(Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, drag.current.startWidth + drag.current.startX - next.clientX))) }
    const up = () => { drag.current = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const state = terminalState(terminal)
  return <aside className="agent-drawer" style={{ width }} aria-label={`${terminal.name} terminal`}>
    <div className="agent-drawer-resize" role="separator" aria-orientation="vertical" aria-label="Resize terminal drawer" onPointerDown={resize} onDoubleClick={() => onWidth(DRAWER_DEFAULT)} />
    <header className="agent-drawer-head">
      <span className={`status-dot state-${state}`} />
      <select aria-label="Terminal shown in drawer" value={terminal.id} onChange={event => onSelect(event.target.value)}>
        {sessions.map(session => <optgroup key={session.id} label={session.name}>{session.terminals.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>)}
      </select>
      <span className={`agent-drawer-status terminal-status state-${state}`} title={terminalStatus(terminal)}>{terminalStatus(terminal)}</span>
      <button className="icon-button" aria-label="Open in Sessions" title="Open in Sessions" onClick={onExpand}><Maximize2 size={14} /></button>
      <button className="icon-button" aria-label="Close terminal drawer" title="Close (⌘J)" onClick={onClose}><X size={15} /></button>
    </header>
    <div className="agent-drawer-body">
      <TerminalView key={terminal.id} session={terminal} onError={onError} patch={terminal.terminalKind === 'shell' ? undefined : patch} themeMode={themeMode} themeBackground={themeBackground} themeAccent={themeAccent} />
    </div>
  </aside>
}
