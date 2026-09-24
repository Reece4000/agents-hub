import { EventEmitter } from 'node:events'
import { connect, type Socket } from 'node:net'
import { isStaleGeneration, parseSupervisorFrame, SUPERVISOR_PROTOCOL_VERSION, type SupervisorEvent, type SupervisorMethod, type SupervisorResponse } from './supervisor-protocol'
import type { OpenSpec } from './terminals'

type Snapshot = { data: string; seq: number; cols: number; rows: number; running: boolean }

/** The app's side of the supervisor: the same surface as the in-process
 *  `Terminals` (open, write, resize, stop, running, and data/exit/attention/
 *  input events), backed by terminals that live in the supervisor process
 *  and survive the app quitting. `close` only disconnects. */
export class SupervisorClient extends EventEmitter {
  private nextId = 0
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private alive = new Set<string>()
  private generations = new Map<string, number>()
  private tails = new Map<string, string>()
  private constructor(private socket: Socket) {
    super()
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        try { this.frame(parseSupervisorFrame(JSON.parse(line)) as SupervisorResponse | SupervisorEvent) } catch { /* ignore a malformed frame */ }
      }
    })
    socket.on('close', () => {
      // The supervisor is gone, and its terminals with it.
      for (const request of this.pending.values()) request.reject(new Error('The terminal supervisor disconnected.'))
      this.pending.clear()
      for (const id of this.alive) this.emit('exit', { id, exitCode: -1 })
      this.alive.clear()
      this.emit('disconnected')
    })
    socket.on('error', () => {})
  }

  /** Connect to the supervisor at `socketPath`, calling `start` to launch
   *  one when none is listening, then wait for it to come up. */
  static async connect(socketPath: string, start: () => void, timeoutMs = 5000): Promise<SupervisorClient> {
    const attempt = () => new Promise<Socket>((resolve, reject) => { const socket = connect(socketPath, () => resolve(socket)); socket.once('error', reject) })
    let socket: Socket
    try { socket = await attempt() }
    catch {
      start()
      const deadline = Date.now() + timeoutMs
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 80))
        try { socket = await attempt(); break } catch (error) { if (Date.now() > deadline) throw new Error(`The terminal supervisor did not start: ${(error as Error).message}`) }
      }
    }
    const client = new SupervisorClient(socket)
    const hello = await client.request('hello', { versions: [SUPERVISOR_PROTOCOL_VERSION] }) as { running: string[] }
    for (const id of hello.running) client.alive.add(id)
    return client
  }

  private frame(frame: SupervisorResponse | SupervisorEvent) {
    if ('event' in frame) {
      if (isStaleGeneration(this.generations.get(frame.resourceId) ?? 0, frame.generation)) return
      this.generations.set(frame.resourceId, frame.generation)
      if (frame.event === 'data') this.emit('data', { id: frame.resourceId, data: frame.data, seq: frame.seq })
      else if (frame.event === 'attention') this.emit('attention', { id: frame.resourceId, message: frame.message })
      else { this.alive.delete(frame.resourceId); this.emit('exit', { id: frame.resourceId, exitCode: frame.exitCode }) }
      return
    }
    const request = this.pending.get(frame.id)
    if (!request) return
    this.pending.delete(frame.id)
    if (frame.ok) request.resolve(frame.result)
    else request.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }))
  }
  private request(method: SupervisorMethod, params: Record<string, unknown> = {}) {
    const id = ++this.nextId
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.write(`${JSON.stringify({ v: SUPERVISOR_PROTOCOL_VERSION, id, method, params })}\n`)
    })
  }

  running(id: string) { return this.alive.has(id) }
  runningIds() { return [...this.alive] }
  async open(id: string, cwd: string, spec: OpenSpec): Promise<Snapshot> {
    const result = await this.request('open', { id, cwd, spec }) as Snapshot & { generation: number; tail?: string }
    this.generations.set(id, result.generation)
    if (result.running) this.alive.add(id); else { this.alive.delete(id); this.tails.set(id, result.tail ?? '') }
    return { data: result.data, seq: result.seq, cols: result.cols, rows: result.rows, running: result.running }
  }
  write(id: string, data: string) {
    if (!this.alive.has(id) || typeof data !== 'string' || data.length > 1_000_000) return
    void this.request('input', { id, data }).catch(() => {})
    this.emit('input', { id, data })
  }
  resize(id: string, cols: number, rows: number) { void this.request('resize', { id, cols, rows }).catch(() => {}) }
  async stop(id: string) { await this.request('stop', { id }) }
  screenText(id: string) { return this.tails.get(id) ?? '' }
  /** Stop every terminal and the supervisor itself. */
  async shutdown() { await this.request('shutdown').catch(() => {}); this.socket.end() }
  /** Disconnect; the supervisor keeps the terminals running. */
  close() { this.socket.end() }
}
