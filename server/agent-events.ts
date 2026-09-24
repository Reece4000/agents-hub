import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const MAX_BODY = 8 * 1024 * 1024

/** Loopback endpoint that agent hooks post structured events to. Each
 *  terminal gets its own URL carrying its id and a secret token, so another
 *  local page or process cannot inject events. One POST is one event, which
 *  keeps concurrent hooks (parallel tool calls) from interleaving. */
export class AgentEventServer {
  private server?: Server
  private starting?: Promise<string>
  private token = randomBytes(16).toString('hex')
  private preferredPort = 0
  /** `stateFile` keeps the port and token across app restarts, so agents
   *  that kept running in the supervisor still reach their hook URLs. */
  constructor(private onEvent: (terminalId: string, payload: Record<string, unknown>) => void, private stateFile = '') {
    if (!stateFile) return
    try {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as { port?: unknown; token?: unknown }
      if (typeof saved.token === 'string' && /^[a-f0-9]{32}$/.test(saved.token)) this.token = saved.token
      if (Number.isInteger(saved.port) && Number(saved.port) > 1024 && Number(saved.port) < 65536) this.preferredPort = Number(saved.port)
    } catch { /* first run */ }
  }

  /** Base URL once listening; call `urlFor` for a terminal's endpoint. */
  start(): Promise<string> {
    this.starting ??= new Promise<string>((resolve, reject) => {
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const terminal = url.searchParams.get('terminal') ?? ''
        if (request.method !== 'POST' || url.pathname !== '/event' || url.searchParams.get('token') !== this.token || !/^[\w-]{1,120}$/.test(terminal)) {
          request.resume(); response.writeHead(404).end(); return
        }
        const chunks: Buffer[] = []
        let size = 0
        request.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= MAX_BODY) chunks.push(chunk) })
        request.on('end', () => {
          response.writeHead(204).end()
          if (size > MAX_BODY) return
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (payload && typeof payload === 'object' && !Array.isArray(payload)) this.onEvent(terminal, payload)
          } catch { /* a malformed event is dropped; the terminal keeps its last state */ }
        })
      })
      const listen = (port: number) => server.listen(port, '127.0.0.1')
      server.on('error', (error: NodeJS.ErrnoException) => { if (error.code === 'EADDRINUSE' && this.preferredPort) { this.preferredPort = 0; listen(0) } else reject(error) })
      server.on('listening', () => {
        const address = server.address()
        if (!address || typeof address === 'string') { reject(new Error('Agent event server has no port.')); return }
        server.unref()
        this.server = server
        if (this.stateFile) try { writeFileSync(this.stateFile, JSON.stringify({ port: address.port, token: this.token }), { mode: 0o600 }) } catch { /* hooks still work until the next restart */ }
        resolve(`http://127.0.0.1:${address.port}`)
      })
      listen(this.preferredPort)
    })
    return this.starting
  }
  async urlFor(terminalId: string) {
    return `${await this.start()}/event?terminal=${encodeURIComponent(terminalId)}&token=${this.token}`
  }
  close() { this.server?.close(); this.server = undefined; this.starting = undefined }
}
