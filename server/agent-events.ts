import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'

const MAX_BODY = 8 * 1024 * 1024

/** Loopback endpoint that agent hooks post structured events to. Each
 *  terminal gets its own URL carrying its id and a per-run token, so another
 *  local page or process cannot inject events. One POST is one event, which
 *  keeps concurrent hooks (parallel tool calls) from interleaving. */
export class AgentEventServer {
  private server?: Server
  private starting?: Promise<string>
  private readonly token = randomBytes(16).toString('hex')
  constructor(private onEvent: (terminalId: string, payload: Record<string, unknown>) => void) {}

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
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') { reject(new Error('Agent event server has no port.')); return }
        server.unref()
        this.server = server
        resolve(`http://127.0.0.1:${address.port}`)
      })
    })
    return this.starting
  }
  async urlFor(terminalId: string) {
    return `${await this.start()}/event?terminal=${encodeURIComponent(terminalId)}&token=${this.token}`
  }
  close() { this.server?.close(); this.server = undefined; this.starting = undefined }
}
