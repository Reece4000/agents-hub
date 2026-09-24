import type { AgentState, TerminalResource } from './types'

/** What a terminal tab shows: its agent's live state, or `stopped`. */
export type TerminalState = AgentState | 'stopped'
export function terminalState(terminal: TerminalResource): TerminalState {
  if (!terminal.terminalRunning) return 'stopped'
  const state = terminal.activity?.state
  return state && state !== 'exited' ? state : 'idle'
}

const URGENCY: TerminalState[] = ['waiting', 'working', 'starting', 'idle', 'stopped']
/** The state that most needs the person across several terminals. */
export function mostUrgent(terminals: TerminalResource[]): TerminalState {
  return terminals.map(terminalState).sort((a, b) => URGENCY.indexOf(a) - URGENCY.indexOf(b))[0] ?? 'stopped'
}

export const STATE_LABELS: Record<TerminalState, string> = { waiting: 'Needs you', working: 'Working', starting: 'Starting', idle: 'Idle', exited: 'Exited', stopped: 'Stopped' }

/** Short status line: the agent's own detail when it has one. */
export function terminalStatus(terminal: TerminalResource): string {
  const state = terminalState(terminal)
  if (state === 'stopped') return terminal.conversationId ? 'Stopped · resumes on start' : 'Stopped'
  return terminal.activity?.detail || STATE_LABELS[state]
}
