import { useEffect, useRef, useState } from 'react'
import { ArrowRight, RotateCcw, Sparkles, X } from 'lucide-react'
import { bridge } from './bridge'
import type { BoardSnapshot } from '../shared/board'
import { organizerModels, preferredOrganizerModel, type OrganizerConfig, type OrganizerProvider } from '../shared/organizer-models'

interface Change { id: string; before: { title: string; body: string; kind: string; links: unknown[] }; after: { title: string; body: string; kind: string; links: unknown[] } }
interface LastChange { id: string; at: string; changedNotes: number; movedNotes: number; changes: Change[] }
const initial: OrganizerConfig = { provider: 'codex', model: preferredOrganizerModel('codex'), enabled: false }

export default function OrganizerPanel({ repo, snapshot, blocked, onRefresh, onError, onOrganizing }: { repo: string; snapshot: BoardSnapshot; blocked: boolean; onRefresh: () => Promise<unknown>; onError: (message: string) => void; onOrganizing: (value: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const [config, setConfig] = useState<OrganizerConfig>(initial)
  const [customModel, setCustomModel] = useState(false)
  const [providers, setProviders] = useState<Array<{ kind: string; executable: string | null }>>([])
  const [last, setLast] = useState<LastChange | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const wrap = useRef<HTMLDivElement>(null)
  const signature = JSON.stringify(snapshot.notes.map(note => [note.id, note.userSource?.title, note.userSource?.body]))
  const handled = useRef<string | null>(null)
  const providerAvailable = providers.length === 0 || providers.some(item => item.kind === config.provider && !!item.executable)
  useEffect(() => {
    let live = true
    handled.current = null
    setConfig(initial); setCustomModel(false); setProviders([]); setLast(null); setError('')
    bridge.invoke<{ config: OrganizerConfig; last: LastChange | null }>('board:organizer:get', { repo }).then(value => { if (live) { setConfig(value.config); setCustomModel(!organizerModels[value.config.provider].some(model => model.id === value.config.model)); setLast(value.last) } }).catch(failure => { if (live) setError((failure as Error).message) })
    bridge.invoke<Array<{ kind: string; executable: string | null }>>('terminalProviders').then(value => { if (live) setProviders(value) }).catch(() => {})
    return () => { live = false }
  }, [repo])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape) }
  }, [open])
  const run = async () => {
    if (busy || blocked || !providerAvailable || snapshot.readOnly || snapshot.repo !== repo) return
    setBusy(true); onOrganizing(true); setError(''); handled.current = signature
    try {
      const saved = await bridge.invoke<OrganizerConfig>('board:organizer:save', { repo, config })
      setConfig(saved)
      await bridge.invoke('board:organizer:run', { repo })
      await onRefresh()
      const value = await bridge.invoke<{ config: OrganizerConfig; last: LastChange | null }>('board:organizer:get', { repo })
      setLast(value.last)
    } catch (failure) { const message = (failure as Error).message; setError(message); onError(message) }
    finally { setBusy(false); onOrganizing(false) }
  }
  useEffect(() => {
    if (snapshot.repo !== repo) return
    if (handled.current === null) { handled.current = signature; return }
    if (!config.enabled || !config.model || !providerAvailable || blocked || busy || snapshot.readOnly || handled.current === signature) return
    const timer = setTimeout(() => { void run() }, 1800)
    return () => clearTimeout(timer)
  }, [signature, config.enabled, config.model, providerAvailable, blocked, busy, snapshot.readOnly, snapshot.repo, repo])
  const save = async () => {
    setBusy(true); setError('')
    try {
      const value = await bridge.invoke<OrganizerConfig>('board:organizer:save', { repo, config })
      setConfig(value)
      if (value.enabled) handled.current = ''
    } catch (failure) { setError((failure as Error).message) }
    finally { setBusy(false) }
  }
  const undo = async () => {
    setBusy(true); onOrganizing(true); setError('')
    try { await bridge.invoke('board:organizer:undo', { repo }); await onRefresh(); setLast(null); handled.current = signature }
    catch (failure) { setError((failure as Error).message) }
    finally { setBusy(false); onOrganizing(false) }
  }
  return <div ref={wrap} className="kb-organizer-wrap">
    <button className={`kb-organizer-trigger${config.enabled ? ' active' : ''}`} aria-expanded={open} onClick={() => setOpen(value => !value)}><Sparkles size={14} /> Organize</button>
    {open && <div className="kb-organizer-panel" role="dialog" aria-label="Canvas organizer" onPointerDown={event => event.stopPropagation()}>
      <header><div><strong>Canvas organizer</strong><span>Arrange notes and improve their connections.</span></div><button aria-label="Close organizer" onClick={() => setOpen(false)}><X size={15} /></button></header>
      <label>Agent<select value={config.provider} onChange={event => { const provider = event.target.value as OrganizerProvider; setConfig(value => ({ ...value, provider, model: preferredOrganizerModel(provider) })); setCustomModel(false); setError('') }}><option value="codex" disabled={providers.length > 0 && !providers.find(item => item.kind === 'codex')?.executable}>Codex{providers.length > 0 && !providers.find(item => item.kind === 'codex')?.executable ? ' · CLI not found' : ''}</option><option value="claude" disabled={providers.length > 0 && !providers.find(item => item.kind === 'claude')?.executable}>Claude Code{providers.length > 0 && !providers.find(item => item.kind === 'claude')?.executable ? ' · CLI not found' : ''}</option></select></label>
      <label>Model<select value={customModel ? '__custom__' : config.model} onChange={event => { const model = event.target.value; setCustomModel(model === '__custom__'); setConfig(value => ({ ...value, model: model === '__custom__' ? '' : model })) }}>{organizerModels[config.provider].map(model => <option key={model.id} value={model.id}>{model.label} · {model.detail}</option>)}<option value="__custom__">Other model…</option></select></label>
      {customModel && <label>Custom model ID<input value={config.model} onChange={event => setConfig(value => ({ ...value, model: event.target.value }))} placeholder={config.provider === 'codex' ? 'gpt-6-luna' : 'haiku'} maxLength={120} /></label>}
      <small className="kb-organizer-model-hint">Model access depends on your {config.provider === 'codex' ? 'Codex' : 'Claude Code'} account and settings.</small>
      <label className="kb-organizer-toggle"><input type="checkbox" checked={config.enabled} onChange={event => setConfig(value => ({ ...value, enabled: event.target.checked }))} /><span>Run after I finish editing a note</span></label>
      <p className="kb-organizer-explain">The organizer may edit summaries and links and move existing cards. Your original message stays in each note and the latest run can be undone.</p>
      {error && <p className="kb-organizer-error" role="alert">{error}</p>}
      <div className="kb-organizer-actions"><button disabled={busy || !config.model.trim() || snapshot.readOnly} onClick={() => void save()}>Save settings</button><button disabled={busy || !config.model.trim() || blocked || snapshot.readOnly || snapshot.repo !== repo || !providerAvailable} title={blocked ? 'Close the current editor before organizing' : !providerAvailable ? `${config.provider === 'codex' ? 'Codex' : 'Claude Code'} CLI not found` : undefined} onClick={() => void run()}>{busy ? 'Working…' : 'Organize now'} <ArrowRight size={13} /></button></div>
      {last && <div className="kb-organizer-last"><div><strong>Latest run</strong><span>{last.changedNotes} edited · {last.movedNotes} moved</span><button disabled={busy || blocked} onClick={() => void undo()}><RotateCcw size={12} /> Undo</button></div>{last.changes.length > 0 && <details><summary>Review text changes</summary>{last.changes.map(change => <article key={change.id}><strong>{change.id}</strong><div className="kb-organizer-diff"><div><small>Before</small><pre>{`${change.before.title}\n\n${change.before.body}`}</pre></div><div><small>After</small><pre>{`${change.after.title}\n\n${change.after.body}`}</pre></div></div></article>)}</details>}</div>}
    </div>}
  </div>
}
