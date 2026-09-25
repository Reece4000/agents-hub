import { useEffect, useState } from 'react'
import type { TerminalKind, TerminalProfile } from './types'
import { bridge } from './bridge'

export interface TerminalLaunchRequest {
  contextName: string
  terminalName: string
  terminalKind: TerminalKind
  profile?: TerminalProfile
  providerModel?: string
}

const LABELS: Record<TerminalKind, string> = { codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor Agent', shell: 'Shell', custom: 'Any agent' }
const KINDS: TerminalKind[] = ['codex', 'claude', 'cursor', 'shell', 'custom']
const NATIVE: TerminalKind[] = ['codex', 'claude', 'cursor']

export default function LaunchModal({ repo, contextId, contextName: existingContextName, suggestName, onCancel, onConfirm }: {
  repo?: string
  contextId?: string
  contextName?: string
  suggestName?: string
  onCancel: () => void
  onConfirm: (request: TerminalLaunchRequest) => void
}) {
  const addingToContext = !!contextId
  const [contextName, setContextName] = useState(suggestName ?? '')
  const [terminalName, setTerminalName] = useState('Codex')
  const [kind, setKind] = useState<TerminalKind>('codex')
  const [providers, setProviders] = useState<Array<{ kind: string; label: string; executable: string | null }>>([])
  const [providerModel, setProviderModel] = useState('')
  const [agent, setAgent] = useState('Codex')
  const [executable, setExecutable] = useState('codex')
  const [argumentsText, setArgumentsText] = useState('')
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onCancel() } }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [onCancel])
  useEffect(() => {
    let live = true
    bridge.invoke<Array<{ kind: string; label: string; executable: string | null }>>('terminalProviders').then(items => {
      if (!live) return
      setProviders(items)
      const first = items.find(item => item.executable)
      if (first) { setKind(first.kind as TerminalKind); setTerminalName(first.label) }
      else { setKind('shell'); setTerminalName('Shell') }
    }).catch(() => { if (live) { setKind('shell'); setTerminalName('Shell') } })
    return () => { live = false }
  }, [])
  const chooseKind = (next: TerminalKind) => { setKind(next); setTerminalName(next === 'custom' ? agent || 'Agent' : LABELS[next]); setProviderModel('') }
  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault()
    const profile = kind === 'custom' ? { label: agent.trim().slice(0, 80) || 'Agent', executable: executable.trim().slice(0, 300), args: argumentsText.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 40) } : undefined
    onConfirm({ contextName: contextName.trim().slice(0, 60), terminalName: terminalName.trim().slice(0, 60) || (profile?.label ?? LABELS[kind]), terminalKind: kind, profile, providerModel: NATIVE.includes(kind) ? providerModel.trim() : undefined })
  }
  const title = addingToContext ? 'Add terminal' : 'Create a Session'
  return <div className="modal-overlay" onPointerDown={event => { if (event.target === event.currentTarget) onCancel() }}>
    <form className="modal agent-launch-modal" role="dialog" aria-modal="true" aria-label={title} onSubmit={submit}>
      <header className="modal-header">
        <h2>{title}{repo ? ` · ${repo.split('/').filter(Boolean).at(-1) || repo}` : ''}</h2>
        <p>{addingToContext ? <>Add an agent or shell to <strong>{existingContextName}</strong>. Terminals in a Session can run independently.</> : 'A Session groups the terminals that belong to one piece of work.'}</p>
      </header>
      <div className="modal-fields">
        {!addingToContext && <label>Session name
          <input autoFocus value={contextName} placeholder="frontend" aria-label="Session name" maxLength={60} onChange={event => setContextName(event.target.value)} />
        </label>}
        <fieldset className="agent-kind-fieldset">
          <legend>Terminal profile</legend>
          <div role="radiogroup" aria-label="Terminal profile" className="agent-kind-options">
            {KINDS.map(option => {
              const detected = providers.find(item => item.kind === option)
              const unavailable = !!detected && !detected.executable
              return <label key={option} className={`${kind === option ? 'selected' : ''}${unavailable ? ' unavailable' : ''}`}><input type="radio" name="terminal-kind" checked={kind === option} disabled={unavailable} onChange={() => chooseKind(option)} /><span><strong>{LABELS[option]}</strong><small>{unavailable ? 'CLI not found' : option === 'custom' ? 'Choose an executable' : option === 'shell' ? 'Run commands directly' : 'Installed CLI'}</small></span></label>
            })}
          </div>
        </fieldset>
        <label>Terminal name
          <input autoFocus={addingToContext} value={terminalName} placeholder="agent" aria-label="Terminal name" maxLength={60} onChange={event => setTerminalName(event.target.value)} />
        </label>
        {NATIVE.includes(kind) && <label>Model <small>Optional · use the agent default if blank</small><input value={providerModel} maxLength={120} placeholder={`${LABELS[kind]} default`} onChange={event => setProviderModel(event.target.value)} /></label>}
        {kind === 'custom' && <div className="agent-command-fields">
          <label>Agent name<input value={agent} aria-label="Agent name" maxLength={80} onChange={event => { setAgent(event.target.value); if (!terminalName || Object.values(LABELS).includes(terminalName)) setTerminalName(event.target.value) }} /></label>
          <label>Executable<input value={executable} aria-label="Executable" placeholder="codex" maxLength={300} onChange={event => setExecutable(event.target.value)} /><small>Any command on PATH or an executable path.</small></label>
          <label>Arguments <small>One argument per line. No shell parsing.</small>
            <textarea value={argumentsText} aria-label="Agent arguments" rows={3} placeholder={'--model\no4-mini'} onChange={event => setArgumentsText(event.target.value)} />
          </label>
        </div>}
      </div>
      <footer className="modal-actions">
        <button type="button" className="small-button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary-button">{addingToContext ? 'Add terminal' : 'Create Session'}</button>
      </footer>
    </form>
  </div>
}
