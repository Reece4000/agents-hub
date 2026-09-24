import { createServer, connect, type Server, type Socket } from 'node:net'
import { existsSync, rmSync } from 'node:fs'
import { Terminals, type OpenSpec } from './terminals'
import { coded, negotiateSupervisorVersion, parseSupervisorFrame, type SupervisorEvent, type SupervisorRequest } from './supervisor-protocol'

/** How long an idle supervisor (no app connected, no terminal running)
 *  waits before exiting. */
export const IDLE_EXIT_MS = 5000

/** The process that owns agent terminals, so they keep running while the
 *  app is closed. It serves the supervisor protocol on a Unix socket to any
 *  number of app windows and exits once nothing runs and nobody is
 *  connected. */
export async function runSupervisor(socketPath: string, { idleMs = IDLE_EXIT_MS, onExit = (): void => process.exit(0) }: { idleMs?: number; onExit?: () => void } = {}): Promise<{ close: () => void }> {
  if (existsSync(socketPath)) {
    // A socket file with nobody listening is left over from a crash.
    const alive = await new Promise<boolean>(resolve => { const probe = connect(socketPath, () => { probe.end(); resolve(true) }); probe.on('error', () => resolve(false)) })
    if (alive) throw new Error('Another supervisor is already serving this workspace.')
    rmSync(socketPath, { force: true })
  }
  const terminals = new Terminals()
  const clients = new Set<Socket>()
  const generations = new Map<string, number>()
  const generation = (id: string) => generations.get(id) ?? 0
  let idleTimer: NodeJS.Timeout | undefined
  const checkIdle = () => {
    clearTimeout(idleTimer)
    if (clients.size || terminals.runningIds().length) return
    idleTimer = setTimeout(() => { if (!clients.size && !terminals.runningIds().length) shutdown() }, idleMs)
  }
  const broadcast = (event: SupervisorEvent) => { const line = `${JSON.stringify(event)}\n`; for (const client of clients) client.write(line) }
  terminals.on('data', ({ id, data, seq }) => broadcast({ v: 1, event: 'data', resourceId: id, generation: generation(id), data, seq }))
  terminals.on('attention', ({ id, message }) => broadcast({ v: 1, event: 'attention', resourceId: id, generation: generation(id), message }))
  terminals.on('exit', ({ id, exitCode }) => { broadcast({ v: 1, event: 'exit', resourceId: id, generation: generation(id), exitCode }); checkIdle() })

  const handle = async (request: SupervisorRequest): Promise<unknown> => {
    const params = request.params ?? {}
    const id = typeof params.id === 'string' ? params.id : ''
    switch (request.method) {
      case 'hello': return { version: negotiateSupervisorVersion(params.versions), pid: process.pid, running: terminals.runningIds() }
      case 'open': {
        if (!id || typeof params.cwd !== 'string' || !params.spec || typeof params.spec !== 'object') throw coded('bad-params', 'open needs id, cwd, and spec.')
        if (!terminals.running(id)) generations.set(id, generation(id) + 1)
        const snapshot = await terminals.open(id, params.cwd, params.spec as OpenSpec)
        clearTimeout(idleTimer)
        return { ...snapshot, generation: generation(id), ...(snapshot.running ? {} : { tail: terminals.screenText(id) }) }
      }
      case 'input': terminals.write(id, typeof params.data === 'string' ? params.data : ''); return null
      case 'resize': terminals.resize(id, Number(params.cols), Number(params.rows)); return null
      case 'stop': await terminals.stop(id); return null
      case 'list': return terminals.runningIds().map(resourceId => ({ resourceId, generation: generation(resourceId), running: true }))
      case 'shutdown': setImmediate(shutdown); return null
      default: throw coded('bad-params', `Unsupported method: ${request.method}.`)
    }
  }

  const server: Server = createServer(socket => {
    clients.add(socket); clearTimeout(idleTimer)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        let request: SupervisorRequest
        try { request = parseSupervisorFrame(JSON.parse(line)) as SupervisorRequest } catch (error) { socket.write(`${JSON.stringify({ v: 1, id: -1, ok: false, error: { code: (error as { code?: string }).code ?? 'bad-params', message: (error as Error).message } })}\n`); continue }
        handle(request).then(
          result => socket.write(`${JSON.stringify({ v: 1, id: request.id, ok: true, result })}\n`),
          error => socket.write(`${JSON.stringify({ v: 1, id: request.id, ok: false, error: { code: (error as { code?: string }).code ?? 'spawn-failed', message: (error as Error).message } })}\n`),
        )
      }
    })
    const drop = () => { clients.delete(socket); checkIdle() }
    socket.on('close', drop); socket.on('error', drop)
  })
  let closed = false
  function shutdown() {
    if (closed) return
    closed = true
    clearTimeout(idleTimer)
    terminals.close()
    for (const client of clients) client.destroy()
    server.close()
    rmSync(socketPath, { force: true })
    onExit()
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => resolve()) })
  checkIdle()
  return { close: shutdown }
}
