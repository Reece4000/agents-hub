import { EventEmitter } from 'node:events'
import { basename } from 'node:path'
import type { AgentActivity, AgentState } from '../src/types'

/** Output quiet for this long means a heuristic-tracked agent is idle. */
export const QUIET_MS = 2000
/** Output this soon after a keystroke is treated as echo, not agent work. */
const ECHO_MS = 300

type Entry = { activity: AgentActivity; hooks: boolean; lastInputAt: number; quiet?: NodeJS.Timeout }
type Json = Record<string, unknown>
const text = (value: unknown) => typeof value === 'string' ? value : ''
const clip = (value: string, max = 80) => { const line = value.replace(/\s+/g, ' ').trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line }

/** One-line description of a tool call for the terminal's status line. */
export function describeTool(tool: string, input: Json = {}): string {
  const file = text(input.file_path) || text(input.notebook_path) || text(input.path)
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return file ? `Editing ${basename(file)}` : 'Editing files'
  if (tool === 'Read') return file ? `Reading ${basename(file)}` : 'Reading files'
  if (tool === 'Bash') return text(input.command) ? `Running ${clip(text(input.command), 60)}` : 'Running a command'
  if (tool === 'Grep' || tool === 'Glob') return text(input.pattern) ? `Searching ${clip(text(input.pattern), 50)}` : 'Searching'
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'Browsing the web'
  if (tool === 'Task' || tool === 'Agent') return text(input.description) ? `Delegating: ${clip(text(input.description), 60)}` : 'Delegating to a subagent'
  if (tool === 'TodoWrite') return 'Planning'
  if (/^mcp__agent[-_]hub__/.test(tool)) return 'Updating the board'
  if (tool.startsWith('mcp__')) return `Using ${tool.split('__').slice(1).join(' ')}`
  return tool ? `Using ${tool}` : 'Working'
}

/** Tracks what each agent terminal is doing. Structured hook events (Claude
 *  Code hooks, Codex notify) are authoritative once seen; before that, and for
 *  agents without hooks, terminal signals drive the state: output means
 *  working, a quiet screen means idle, and a bell or OSC 9/777 notification
 *  means the agent wants attention. Emits `change` with (id, activity). */
export class ActivityTracker extends EventEmitter {
  private entries = new Map<string, Entry>()
  constructor(private now: () => number = Date.now) { super() }

  get(id: string): AgentActivity | undefined { return this.entries.get(id)?.activity }
  /** The provider's own conversation id, when a hook reported one. */
  providerSession(id: string) { return this.entries.get(id)?.activity.providerSessionId }

  /** `hooks`: the agent was launched with structured reporting, so screen
   *  output is not read as work (only a quiet screen ends `starting`). */
  start(id: string, { hooks = false } = {}) {
    const previous = this.entries.get(id)
    if (previous?.quiet) clearTimeout(previous.quiet)
    this.entries.set(id, { activity: this.make('starting', 'Starting', hooks ? 'hooks' : 'terminal'), hooks, lastInputAt: 0 })
    this.emit('change', id, this.entries.get(id)!.activity)
  }
  exit(id: string, code?: number) {
    const entry = this.entries.get(id)
    if (!entry) return
    if (entry.quiet) clearTimeout(entry.quiet)
    this.set(id, 'exited', code ? `Exited with code ${code}` : 'Exited')
  }
  forget(id: string) {
    const entry = this.entries.get(id)
    if (entry?.quiet) clearTimeout(entry.quiet)
    this.entries.delete(id)
  }

  input(id: string, data: string) {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.lastInputAt = this.now()
    // Answering a prompt or submitting a message hands control back to the agent.
    if (entry.activity.state === 'waiting' || (entry.activity.state === 'idle' && data.includes('\r'))) this.set(id, 'working', entry.activity.state === 'waiting' ? 'Continuing' : 'Thinking')
  }
  output(id: string) {
    const entry = this.entries.get(id)
    if (!entry || entry.activity.state === 'exited' || (entry.hooks && entry.activity.state !== 'starting')) return
    const now = this.now()
    if (entry.quiet) clearTimeout(entry.quiet)
    entry.quiet = setTimeout(() => this.quiet(id), QUIET_MS)
    entry.quiet.unref?.()
    if (now - entry.lastInputAt < ECHO_MS || entry.activity.state === 'waiting') return
    if (entry.activity.state === 'idle') this.set(id, 'working', 'Working')
  }
  private quiet(id: string) {
    const entry = this.entries.get(id)
    if (!entry) return
    if (entry.activity.state === 'starting') this.set(id, 'idle', 'Ready')
    else if (entry.activity.state === 'working' && !entry.hooks) this.set(id, 'idle', 'Quiet')
  }
  /** Terminal bell, or an OSC 9/777 desktop notification with its message. */
  attention(id: string, message = '') {
    const entry = this.entries.get(id)
    if (!entry || entry.activity.state === 'exited') return
    if (/\b(complete|completed|done|finished)\b/i.test(message)) this.set(id, 'idle', clip(message) || 'Finished')
    else this.set(id, 'waiting', clip(message) || 'Needs your attention')
  }

  /** A structured event from provider hooks: Claude Code hook payloads and
   *  Codex `notify` payloads. Unknown events are ignored. */
  hook(id: string, payload: Json) {
    const entry = this.entries.get(id)
    if (!entry || entry.activity.state === 'exited') return
    const name = text(payload.hook_event_name) || text(payload.type)
    const session = text(payload.session_id) || text(payload['thread-id']) || text(payload.thread_id)
    if (session) entry.activity.providerSessionId = session
    const mark = (state: AgentState, detail: string) => {
      entry.hooks = true
      if (entry.quiet) { clearTimeout(entry.quiet); entry.quiet = undefined }
      this.set(id, state, detail)
    }
    switch (name) {
      case 'SessionStart': return mark('idle', 'Ready')
      case 'UserPromptSubmit': return mark('working', 'Thinking')
      case 'PreToolUse': return mark('working', describeTool(text(payload.tool_name), (payload.tool_input ?? {}) as Json))
      case 'PermissionRequest': return mark('waiting', `Approve ${describeTool(text(payload.tool_name), (payload.tool_input ?? {}) as Json).replace(/^\w/, c => c.toLowerCase())}`)
      case 'Notification': {
        const type = text(payload.notification_type)
        if (type === 'idle_prompt') return mark('idle', entry.activity.state === 'idle' ? entry.activity.detail : 'Waiting for your next message')
        if (/permission|elicitation|needs_input/.test(type) || !type) return mark('waiting', clip(text(payload.message)) || 'Needs your input')
        return
      }
      case 'Stop': return mark('idle', clip(text(payload.last_assistant_message)) || 'Finished')
      case 'agent-turn-complete': return mark('idle', clip(text(payload['last-assistant-message'])) || 'Finished')
      default: if (session) this.emit('change', id, entry.activity)
    }
  }

  private make(state: AgentState, detail: string, source: AgentActivity['source'], providerSessionId?: string): AgentActivity {
    return { state, detail, since: new Date(this.now()).toISOString(), source, ...(providerSessionId ? { providerSessionId } : {}) }
  }
  private set(id: string, state: AgentState, detail: string) {
    const entry = this.entries.get(id)
    if (!entry) return
    const current = entry.activity
    if (current.state === state && current.detail === detail) return
    entry.activity = this.make(state, detail, entry.hooks ? 'hooks' : 'terminal', current.providerSessionId)
    if (current.state === state) entry.activity.since = current.since
    this.emit('change', id, entry.activity)
  }
}
