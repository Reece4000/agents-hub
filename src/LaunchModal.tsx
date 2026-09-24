import { useEffect, useState } from 'react'
import type { LaunchOptions, TerminalKind, TerminalProfile } from './types'
import { bridge } from './bridge'

export const LAUNCH_STORAGE_KEY = 'agent-hub-muse-launch-v1'
export const DEFAULT_LAUNCH: LaunchOptions = {
  model: '', reasoningEffort: '', approvalMode: 'on-request', permissionProfile: '', trustWorkspace: false, yolo: false,
}
export interface TerminalLaunchRequest {
  contextName: string
  terminalName: string
  terminalKind: TerminalKind
  launch: LaunchOptions
  profile?: TerminalProfile
  providerModel?: string
}

export function loadLaunchDefaults(): LaunchOptions {
  try {
    const raw = JSON.parse(localStorage.getItem(LAUNCH_STORAGE_KEY) || 'null') as Partial<LaunchOptions> | null
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_LAUNCH }
    return {
      model: typeof raw.model === 'string' ? raw.model.slice(0, 200) : '',
      reasoningEffort: ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(raw.reasoningEffort as string) ? raw.reasoningEffort as LaunchOptions['reasoningEffort'] : '',
      approvalMode: ['untrusted', 'on-request', 'never'].includes(raw.approvalMode as string) ? raw.approvalMode as LaunchOptions['approvalMode'] : 'on-request',
      permissionProfile: typeof raw.permissionProfile === 'string' ? raw.permissionProfile.slice(0, 200) : '',
      trustWorkspace: raw.trustWorkspace === true, yolo: raw.yolo === true,
    }
  } catch { return { ...DEFAULT_LAUNCH } }
}

const EFFORTS: LaunchOptions['reasoningEffort'][] = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

export default function LaunchModal({ repo, contextId, contextName: existingContextName, suggestName, models, onCancel, onConfirm }: {
  repo?: string
  contextId?: string
  contextName?: string
  suggestName?: string
  models: { modelId: string; displayLabel: string }[]
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
  const [launch, setLaunch] = useState<LaunchOptions>(loadLaunchDefaults)
  const set = <K extends keyof LaunchOptions>(key: K, value: LaunchOptions[K]) => setLaunch(previous => ({ ...previous, [key]: value }))
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
  const labels: Record<TerminalKind, string> = { codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor Agent', muse: 'Muse', shell: 'Shell', custom: 'Any agent' }
  const chooseKind = (next: TerminalKind) => { setKind(next); setTerminalName(next === 'custom' ? agent || 'Agent' : labels[next]); setProviderModel('') }
  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault()
    const normalized: LaunchOptions = { ...launch, model: launch.model.trim().slice(0, 200), permissionProfile: launch.permissionProfile.trim().slice(0, 200) }
    try { localStorage.setItem(LAUNCH_STORAGE_KEY, JSON.stringify(normalized)) } catch {}
    const profile = kind === 'custom' ? { label: agent.trim().slice(0, 80) || 'Agent', executable: executable.trim().slice(0, 300), args: argumentsText.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 40) } : undefined
    onConfirm({ contextName: contextName.trim().slice(0, 60), terminalName: terminalName.trim().slice(0, 60) || (profile?.label ?? labels[kind]), terminalKind: kind, launch: normalized, profile, providerModel: ['codex', 'claude', 'cursor'].includes(kind) ? providerModel.trim() : undefined })
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
            {(['codex', 'claude', 'cursor', 'muse', 'shell', 'custom'] as TerminalKind[]).map(option => {
              const detected = providers.find(item => item.kind === option)
              const unavailable = !!detected && !detected.executable
              return <label key={option} className={`${kind === option ? 'selected' : ''}${unavailable ? ' unavailable' : ''}`}><input type="radio" name="terminal-kind" checked={kind === option} disabled={unavailable} onChange={() => chooseKind(option)} /><span><strong>{labels[option]}</strong><small>{unavailable ? 'CLI not found' : option === 'custom' ? 'Choose an executable' : option === 'shell' ? 'Run commands directly' : option === 'muse' ? 'Muse terminal' : 'Installed CLI'}</small></span></label>
            })}
          </div>
        </fieldset>
        <label>Terminal name
          <input autoFocus={addingToContext} value={terminalName} placeholder="agent" aria-label="Terminal name" maxLength={60} onChange={event => setTerminalName(event.target.value)} />
        </label>
        {(['codex', 'claude', 'cursor'] as TerminalKind[]).includes(kind) && <label>Model <small>Optional · use the agent default if blank</small><input value={providerModel} maxLength={120} placeholder={`${labels[kind]} default`} onChange={event => setProviderModel(event.target.value)} /></label>}
        {kind === 'custom' && <div className="agent-command-fields">
          <label>Agent name<input value={agent} aria-label="Agent name" maxLength={80} onChange={event => { setAgent(event.target.value); if (!terminalName || ['Muse', 'Shell', 'Codex', 'Claude Code', 'Gemini CLI'].includes(terminalName)) setTerminalName(event.target.value) }} /></label>
          <label>Executable<input value={executable} aria-label="Executable" placeholder="codex" maxLength={300} onChange={event => setExecutable(event.target.value)} /><small>Any command on PATH or an executable path.</small></label>
          <label>Arguments <small>One argument per line. No shell parsing.</small>
            <textarea value={argumentsText} aria-label="Agent arguments" rows={3} placeholder={'--model\no4-mini'} onChange={event => setArgumentsText(event.target.value)} />
          </label>
        </div>}
        {kind === 'muse' && <div className="agent-muse-options">
          <label>Model<input value={launch.model} list="launch-models" placeholder="Muse default" aria-label="Model" onChange={event => set('model', event.target.value)} /><datalist id="launch-models">{models.map(model => <option value={model.modelId} key={model.modelId}>{model.displayLabel}</option>)}</datalist></label>
          <label>Reasoning effort<select value={launch.reasoningEffort} aria-label="Reasoning effort" onChange={event => set('reasoningEffort', event.target.value as LaunchOptions['reasoningEffort'])}>{EFFORTS.map(value => <option value={value} key={value}>{value || 'Default'}</option>)}</select></label>
          <label>Approval mode<select value={launch.approvalMode} aria-label="Approval mode" onChange={event => set('approvalMode', event.target.value as LaunchOptions['approvalMode'])}><option value="on-request">on-request · prompt for untrusted actions</option><option value="untrusted">untrusted · deny unmatched</option><option value="never">never · allow all</option></select></label>
          <label>Permission profile<input value={launch.permissionProfile} placeholder="Optional profile ID" aria-label="Permission profile" onChange={event => set('permissionProfile', event.target.value)} /></label>
          <label className="check-row"><input type="checkbox" checked={launch.trustWorkspace} onChange={event => set('trustWorkspace', event.target.checked)} /> Trust workspace <small>load its skills and rules</small></label>
          <label className="check-row"><input type="checkbox" checked={launch.yolo} onChange={event => set('yolo', event.target.checked)} /> YOLO mode <small>disables approval and sandboxing</small></label>
          {launch.yolo && <p className="modal-warning">YOLO disables approval prompts and filesystem/network sandboxing for this run.</p>}
        </div>}
      </div>
      <footer className="modal-actions">
        <button type="button" className="small-button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary-button">{addingToContext ? 'Add terminal' : 'Create Session'}</button>
      </footer>
    </form>
  </div>
}
