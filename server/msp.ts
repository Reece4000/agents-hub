import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { InitializeResult } from './generated/msp'

export function museExecutable() {
  const candidates = [process.env.AGENT_HUB_MUSE_PATH, join(homedir(), '.local/bin/muse'), '/opt/homebrew/bin/muse', '/usr/local/bin/muse']
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? 'muse'
}
export function museEnvironment(extra: NodeJS.ProcessEnv = {}) {
  return { ...process.env, MUSE_NO_AUTO_UPDATE: '1', PATH: `${process.env.PATH ?? ''}:${homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, ...extra }
}
export class MspClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private nextId = 0
  private starting?: Promise<InitializeResult>
  private lastStderr = ''
  constructor(private options: { env?: NodeJS.ProcessEnv; executable?: string; args?: string[] } = {}) { super() }
  forkClient() { return new MspClient(this.options) }
  async start(): Promise<InitializeResult> {
    if (this.starting) return this.starting
    this.starting = this.initialize()
    try { return await this.starting } catch (error) { this.stop(); throw error }
  }
  private async initialize() {
    const child = spawn(this.options.executable ?? museExecutable(), this.options.args ?? ['serve'], { env: museEnvironment(this.options.env), stdio: 'pipe' })
    this.child = child
    child.stdin.on('error', error => this.fail(error))
    child.on('error', error => this.fail(new Error(`Could not start Muse: ${error.message}`)))
    child.stderr.on('data', data => { this.lastStderr = (this.lastStderr + data.toString()).slice(-1500) })
    child.on('exit', () => {
      if (this.child !== child) return
      this.child = undefined
      this.starting = undefined
      this.fail(new Error(`Muse disconnected.${this.lastStderr ? ' ' + this.lastStderr : ' Reopen the conversation to reconnect.'}`))
      this.emit('disconnected')
    })
    createInterface({ input: child.stdout }).on('line', line => {
      let frame: any
      try { frame = JSON.parse(line) } catch { return }
      if (frame.method) {
        this.emit('notification', frame.method === 'approval/request' ? 'approval/requested' : frame.method === 'userInput/request' ? 'userInput/requested' : frame.method, frame.params ?? {})
        // Acknowledgement is delivery receipt; approval decisions are separate explicit commands.
        if (frame.id !== undefined) this.write({ jsonrpc: '2.0', id: frame.id, result: { status: 'accepted' } })
      } else {
        const request = this.pending.get(frame.id)
        if (!request) return
        clearTimeout(request.timer)
        this.pending.delete(frame.id)
        if (frame.error) request.reject(new Error(`${frame.error.message}${frame.error.data ? ': ' + JSON.stringify(frame.error.data) : ''}`))
        else request.resolve(frame.result)
      }
    })
    const result = await this.request<InitializeResult>('initialize', { clientInfo: { name: 'agent_hub', title: 'Agent Hub', version: '0.7.0' } })
    this.write({ jsonrpc: '2.0', method: 'initialized' })
    return result
  }
  request<T = any>(method: string, params?: unknown): Promise<T> {
    if (!this.child) return Promise.reject(new Error('Muse is not connected.'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Muse timed out during ${method}.`)) }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }
  private write(frame: unknown) { this.child?.stdin.write(JSON.stringify(frame) + '\n') }
  private fail(error: Error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error) }
    this.pending.clear()
  }
  async stopAndWait() {
    const child = this.child
    if (!child) return
    this.child = undefined; this.starting = undefined
    this.fail(new Error('Muse connection closed.'))
    await new Promise<void>(resolve => {
      const timer=setTimeout(()=>child.kill('SIGTERM'),1500)
      child.once('exit',()=>{clearTimeout(timer);resolve()})
      child.stdin.end()
    })
  }

  stop() {
    const child = this.child
    this.child = undefined
    this.starting = undefined
    child?.stdin.end()
    child?.kill()
    this.fail(new Error('Muse connection closed.'))
  }
}
