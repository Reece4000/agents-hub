import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Check, CircleAlert, FileText, Plus, RotateCw, X } from 'lucide-react'
import { bridge } from './bridge'
import type { RepoContext, Ticket, TicketPriority, TicketStatus } from './types'

const workflow: { id: TicketStatus; label: string }[] = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'planning', label: 'Planning' },
  { id: 'ready', label: 'Ready' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'needs_testing', label: 'Needs testing' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'completed', label: 'Completed' },
]
const priorities: TicketPriority[] = ['low', 'normal', 'high', 'urgent']
const statusName = (status: TicketStatus) => workflow.find(item => item.id === status)?.label ?? status
const stamp = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

function TicketEditor({ ticket, contexts, onCancel, onSave, saving }: {
  ticket: Ticket | null
  contexts: RepoContext[]
  onCancel: () => void
  onSave: (ticket: Partial<Ticket>) => void
  saving: boolean
}) {
  const agents = useMemo(() => [...new Set(contexts.flatMap(context => context.terminals.map(terminal => terminal.agent).filter(Boolean)))].sort(), [contexts])
  const [title, setTitle] = useState(ticket?.title ?? '')
  const [description, setDescription] = useState(ticket?.description ?? '')
  const [acceptance, setAcceptance] = useState(ticket?.acceptance.join('\n') ?? '')
  const [priority, setPriority] = useState<TicketPriority>(ticket?.priority ?? 'normal')
  const [status, setStatus] = useState<TicketStatus>(ticket?.status ?? 'backlog')
  const [agent, setAgent] = useState(ticket?.agent ?? '')
  const [contextId, setContextId] = useState(ticket?.contextId ?? '')

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const context = contexts.find(item => item.id === contextId)
    onSave({ title: title.trim(), description: description.trim(), acceptance: acceptance.split('\n').map(line => line.trim()).filter(Boolean), priority, status, agent: agent.trim(), contextId, contextName: context?.name ?? '' })
  }

  return <div className="ticket-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onCancel() }}>
    <form className="ticket-editor" role="dialog" aria-modal="true" aria-labelledby="ticket-editor-title" onSubmit={submit}>
      <header className="ticket-editor-header">
        <div><span className="ticket-kicker">WORKSPACE TICKET</span><h2 id="ticket-editor-title">{ticket ? 'Edit ticket' : 'Create a ticket'}</h2><p>Write down the outcome an agent should deliver and how you’ll know it’s done.</p></div>
        <button type="button" className="icon-button" aria-label="Close ticket editor" onClick={onCancel}><X size={17} /></button>
      </header>
      {ticket && <div className="ticket-id">{ticket.id}</div>}
      <label className="ticket-field">Title<input autoFocus required maxLength={160} placeholder="Add a workspace level task" value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label className="ticket-field">Description<textarea rows={4} maxLength={60000} placeholder="What needs to change? Include the useful context an agent needs to get started." value={description} onChange={event => setDescription(event.target.value)} /></label>
      <label className="ticket-field">Acceptance criteria <span className="field-hint">One check per line</span><textarea rows={3} placeholder={'The board shows the updated status\nA second agent can read the ticket file'} value={acceptance} onChange={event => setAcceptance(event.target.value)} /></label>
      <div className="ticket-form-grid">
        <label className="ticket-field">Priority<select value={priority} onChange={event => setPriority(event.target.value as TicketPriority)}>{priorities.map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></label>
        <label className="ticket-field">Workflow stage<select value={status} onChange={event => setStatus(event.target.value as TicketStatus)}>{workflow.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className="ticket-field">Assigned agent<input list="ticket-agents" maxLength={120} placeholder="Unassigned" value={agent} onChange={event => setAgent(event.target.value)} /><datalist id="ticket-agents">{agents.map(name => <option key={name} value={name} />)}</datalist></label>
        <label className="ticket-field">Context<select value={contextId} onChange={event => setContextId(event.target.value)}><option value="">No context assigned</option>{contexts.map(context => <option key={context.id} value={context.id}>{context.name}</option>)}</select></label>
      </div>
      <footer className="ticket-editor-footer"><button type="button" className="small-button" disabled={saving} onClick={onCancel}>Cancel</button><button className="primary-button" disabled={saving || !title.trim()}>{saving ? 'Saving…' : ticket ? 'Save changes' : 'Create ticket'}</button></footer>
    </form>
  </div>
}

export default function TicketBoard({ repo, contexts, onError }: { repo: string; contexts: RepoContext[]; onError: (message: string) => void }) {
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Ticket | null | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const dragId = useRef<string | null>(null)
  const agents = useMemo(() => [...new Set(contexts.flatMap(context => context.terminals.map(terminal => terminal.agent).filter(Boolean)))], [contexts])

  const refresh = async () => {
    setLoading(true)
    try { setTickets(await bridge.invoke<Ticket[]>('tickets:list', { repo })); setError('') }
    catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); setError(message); onError(message) }
    finally { setLoading(false) }
  }
  useEffect(() => {
    let live = true
    setTickets([]); setLoading(true); setError('')
    bridge.invoke<Ticket[]>('tickets:list', { repo }).then(value => { if (live) { setTickets(value); setError('') } }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : String(cause)) }).finally(() => { if (live) setLoading(false) })
    const stop = bridge.onTickets?.(snapshot => { if (live && snapshot.repo === repo) { if (!snapshot.error) setTickets(snapshot.tickets); setError(snapshot.error ?? '') } })
    return () => { live = false; stop?.() }
  }, [repo])

  const save = async (patch: Partial<Ticket>) => {
    setSaving(true)
    try {
      if (editing && editing !== null) {
        const updated = await bridge.invoke<Ticket>('tickets:update', { repo, id: editing.id, patch, expectedUpdatedAt: editing.updatedAt })
        setTickets(current => current.map(item => item.id === updated.id ? updated : item))
      } else {
        const created = await bridge.invoke<Ticket>('tickets:create', { repo, ticket: patch })
        setTickets(current => [created, ...current])
      }
      setEditing(undefined)
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setSaving(false) }
  }
  const move = async (ticket: Ticket, status: TicketStatus) => {
    if (ticket.status === status) return
    const before = tickets
    setTickets(current => current.map(item => item.id === ticket.id ? { ...item, status, updatedAt: new Date().toISOString() } : item))
    try {
      const updated = await bridge.invoke<Ticket>('tickets:update', { repo, id: ticket.id, patch: { status }, expectedUpdatedAt: ticket.updatedAt })
      setTickets(current => current.map(item => item.id === updated.id ? updated : item))
    } catch (cause) { setTickets(before); void refresh(); onError(cause instanceof Error ? cause.message : String(cause)) }
  }

  const ticketCount = tickets.length
  return <section className="ticket-board" aria-label={`Tickets for ${repo}`}>
    <div className="board-toolbar">
      <div><span className="ticket-kicker">WORKSPACE QUEUE</span><h2>Tickets <span>{ticketCount}</span></h2><p>Turn a rough request into a clear handoff, then track it through delivery.</p></div>
      <div className="board-actions"><div className="ticket-file-note"><FileText size={14} /><code>.agents-hub/tickets/*.json</code><span>agent readable</span></div><button className="primary-button" onClick={() => setEditing(null)}><Plus size={15} />New ticket</button></div>
    </div>
    {error && <div className="ticket-load-error" role="alert"><CircleAlert size={16} /><span>Could not load workspace tickets. {error}</span><button className="small-button" onClick={() => void refresh()}><RotateCw size={13} />Try again</button></div>}
    {loading ? <div className="board-loading">Loading workspace tickets…</div> : <div className="ticket-lanes" aria-label="Ticket workflow board">
      {workflow.map((lane, laneIndex) => {
        const items = tickets.filter(ticket => ticket.status === lane.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        return <section className={`ticket-lane lane-${lane.id}`} key={lane.id} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const id = event.dataTransfer.getData('text/plain') || dragId.current; const ticket = tickets.find(item => item.id === id); if (ticket) void move(ticket, lane.id); dragId.current = null }} aria-label={`${lane.label}, ${items.length} tickets`}>
          <header className="lane-header"><span className="lane-marker" /><h3>{lane.label}</h3><span className="lane-count">{items.length}</span><span className="lane-order">{String(laneIndex + 1).padStart(2, '0')}</span></header>
          <div className="lane-cards">{items.map(ticket => { const assignedContext = contexts.find(context => context.id === ticket.contextId)?.name ?? ticket.contextName; return <article key={ticket.id} className={`ticket-card priority-${ticket.priority}`} draggable onDragStart={event => { dragId.current = ticket.id; event.dataTransfer.setData('text/plain', ticket.id); event.dataTransfer.effectAllowed = 'move' }} onDragEnd={() => { dragId.current = null }}>
            <button className="ticket-card-main" onClick={() => setEditing(ticket)} aria-label={`Edit ${ticket.title}, ${statusName(ticket.status)}`}>
              <span className="ticket-card-top"><code>{ticket.id}</code><span className={`priority-label priority-${ticket.priority}`}>{ticket.priority}</span></span>
              <strong>{ticket.title}</strong>
              {ticket.description && <span className="ticket-description">{ticket.description}</span>}
              {!!ticket.acceptance.length && <span className="ticket-acceptance"><Check size={13} />{ticket.acceptance.length} acceptance {ticket.acceptance.length === 1 ? 'check' : 'checks'}</span>}
              {(ticket.agent || assignedContext) && <span className="ticket-assignment"><span>{ticket.agent || 'Agent unassigned'}</span>{assignedContext && <><span className="assignment-divider">·</span><span>{assignedContext}</span></>}</span>}
              <span className="ticket-card-bottom"><span>{stamp(ticket.updatedAt)}</span><span className="edit-ticket">Open details</span></span>
            </button>
            <label className="ticket-move"><span className="sr-only">Move {ticket.title} to</span><select value={ticket.status} onChange={event => void move(ticket, event.target.value as TicketStatus)} aria-label={`Move ${ticket.title} to another stage`}>{workflow.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><ArrowDown size={12} /></label>
          </article>})}
            {!items.length && <div className="lane-empty">Drop a ticket here</div>}
          </div>
        </section>
      })}
    </div>}
    {!loading && !error && !ticketCount && <div className="ticket-empty"><span className="empty-mark"><FileText size={21} /></span><h3>Start with one clear outcome</h3><p>Tickets live beside the repository in <code>.agents-hub/tickets/</code>. Any terminal agent can read them and update its stage.</p><button className="primary-button" onClick={() => setEditing(null)}><Plus size={15} />Create the first ticket</button></div>}
    {ticketCount > 0 && <div className="board-footer"><span>Drag tickets between stages, or open one to edit its handoff.</span><span className="board-footer-agents"><span className="status-dot working" />{agents.length ? `${agents.length} agent${agents.length === 1 ? '' : 's'} available in contexts` : 'Agent terminals can be added in Contexts'}</span></div>}
    {editing !== undefined && <TicketEditor ticket={editing} contexts={contexts} onCancel={() => setEditing(undefined)} onSave={patch => void save(patch)} saving={saving} />}
  </section>
}
