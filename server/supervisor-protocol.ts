/** Supervisor protocol v1: JSON frames, newline-delimited over the Unix
 *  socket between the app and the process that owns agent terminals. Every frame carries `v`; the
 *  client offers versions in `hello` and the server answers the highest it
 *  supports or errors `incompatible-version`. No silent downgrade, ever. */

export const SUPERVISOR_PROTOCOL_VERSION = 1 as const

export const SUPERVISOR_METHODS = [
  'hello',
  'open',
  'attach',
  'input',
  'resize',
  'stop',
  'list',
  'shutdown',
] as const
export type SupervisorMethod = (typeof SUPERVISOR_METHODS)[number]

export interface SupervisorRequest {
  v: number
  id: number
  method: SupervisorMethod
  params?: Record<string, unknown>
}

export interface SupervisorError {
  code:
    | 'incompatible-version'
    | 'unknown-resource'
    | 'spawn-failed'
    | 'not-running'
    | 'bad-params'
  message: string
}

export type SupervisorResponse =
  | { v: number; id: number; ok: true; result: unknown }
  | { v: number; id: number; ok: false; error: SupervisorError }

/** Server-push PTY output and lifetime. Every event carries the spawn
 *  generation so clients can ignore stale events after reopen/restart. */
export type SupervisorEvent =
  | { v: 1; event: 'data'; resourceId: string; generation: number; data: string; seq: number }
  | { v: 1; event: 'exit'; resourceId: string; generation: number; exitCode: number }
  | { v: 1; event: 'attention'; resourceId: string; generation: number; message: string }

/** Reattach snapshot: today's `Terminals.open` return plus generation. A
 *  client behind the output ring gets a fresh snapshot with resync set. */
export interface AttachSnapshot {
  resourceId: string
  generation: number
  data: string
  seq: number
  cols: number
  rows: number
  running: boolean
  resync?: boolean
}

export interface ResourceState {
  resourceId: string
  generation: number
  kind: string
  running: boolean
  exitCode?: number
  startedAt?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Parse one inbound frame. Throws `Error` with a `SupervisorError['code']`
 *  as `code` on the error object so the socket layer can answer directly. */
export function parseSupervisorFrame(value: unknown): SupervisorRequest | SupervisorResponse | SupervisorEvent {
  if (!isRecord(value)) throw coded('bad-params', 'Frame must be a JSON object.')
  if (value.v !== SUPERVISOR_PROTOCOL_VERSION) throw coded('incompatible-version', `Unsupported protocol version: ${String(value.v)}.`)
  if (typeof value.event === 'string') return parseEvent(value)
  if (typeof value.method === 'string' || 'id' in value) return parseMessage(value)
  throw coded('bad-params', 'Frame is neither a request, response, nor event.')
}

function parseMessage(value: Record<string, unknown>): SupervisorRequest | SupervisorResponse {
  if (typeof value.id !== 'number' || !Number.isInteger(value.id)) throw coded('bad-params', 'Frame id must be an integer.')
  if (typeof value.ok === 'boolean') {
    if (value.ok) return { v: 1, id: value.id, ok: true, result: value.result }
    if (!isRecord(value.error) || typeof value.error.code !== 'string' || typeof value.error.message !== 'string') {
      throw coded('bad-params', 'Error responses carry {code, message}.')
    }
    return { v: 1, id: value.id, ok: false, error: { code: value.error.code as SupervisorError['code'], message: value.error.message } }
  }
  if (typeof value.method !== 'string' || !(SUPERVISOR_METHODS as readonly string[]).includes(value.method)) {
    throw coded('bad-params', `Unknown method: ${String(value.method)}.`)
  }
  if (value.params !== undefined && !isRecord(value.params)) throw coded('bad-params', 'Params must be an object.')
  return { v: 1, id: value.id, method: value.method as SupervisorMethod, ...(value.params === undefined ? {} : { params: value.params }) }
}

function parseEvent(value: Record<string, unknown>): SupervisorEvent {
  if (typeof value.resourceId !== 'string' || !value.resourceId) throw coded('bad-params', 'Events carry a resourceId.')
  if (typeof value.generation !== 'number' || !Number.isInteger(value.generation) || value.generation < 0) {
    throw coded('bad-params', 'Events carry a non-negative integer generation.')
  }
  if (value.event === 'data') {
    if (typeof value.data !== 'string' || typeof value.seq !== 'number' || !Number.isInteger(value.seq)) {
      throw coded('bad-params', 'Data events carry string data and an integer seq.')
    }
    return { v: 1, event: 'data', resourceId: value.resourceId, generation: value.generation, data: value.data, seq: value.seq }
  }
  if (value.event === 'exit') {
    if (typeof value.exitCode !== 'number' || !Number.isInteger(value.exitCode)) throw coded('bad-params', 'Exit events carry an integer exitCode.')
    return { v: 1, event: 'exit', resourceId: value.resourceId, generation: value.generation, exitCode: value.exitCode }
  }
  if (value.event === 'attention') return { v: 1, event: 'attention', resourceId: value.resourceId, generation: value.generation, message: typeof value.message === 'string' ? value.message : '' }
  throw coded('bad-params', `Unknown event: ${String(value.event)}.`)
}

/** Hello negotiation: the client offers versions, the server answers the
 *  highest it supports. Today only v1 exists on both sides. */
export function negotiateSupervisorVersion(offered: unknown): 1 {
  if (!Array.isArray(offered) || !offered.includes(SUPERVISOR_PROTOCOL_VERSION)) {
    throw coded('incompatible-version', 'No shared supervisor protocol version.')
  }
  return SUPERVISOR_PROTOCOL_VERSION
}

/** Stale-event rule: ignore anything from an older generation than the one
 *  the client has attached. Equal-or-newer always applies. */
export function isStaleGeneration(known: number, incoming: number): boolean {
  return incoming < known
}

export function coded(code: SupervisorError['code'], message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}
