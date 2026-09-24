import { EventEmitter } from 'node:events'
import { spawn, type IPty } from 'node-pty'
import headless from '@xterm/headless'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
const { Terminal } = headless
import { SerializeAddon } from '@xterm/addon-serialize'
import { agentEnvironment, shellExecutable } from './provider-profiles'
import type { TerminalKind, TerminalProfile } from '../src/types'

export interface OpenSpec { kind: TerminalKind; profile?: TerminalProfile; env?: Record<string, string>; cols?: number; rows?: number }
type Running = { pty: IPty; screen: HeadlessTerminal; serializer: SerializeAddon; seq: number; alive: boolean; exited: Promise<void>; resolveExit: () => void }
export class Terminals extends EventEmitter {
  private entries = new Map<string, Running>()
  running(id: string) { return this.entries.get(id)?.alive ?? false }
  /** Attach to a terminal, spawning it first when it is not running. Shells
   *  run as a login shell; every other kind runs its profile's executable and
   *  argv directly, with no shell interpolation. */
  async open(id: string, repo: string, { kind, profile, env: extraEnv = {}, cols = 90, rows = 28 }: OpenSpec) {
    let entry = this.entries.get(id)
    if (!entry?.alive) {
      entry?.screen.dispose()
      if (kind !== 'shell' && (!profile?.executable || !Array.isArray(profile.args))) throw new Error('Choose a command for this agent terminal.')
      const screen = new Terminal({ cols, rows, scrollback: 3000, allowProposedApi: true })
      const serializer = new SerializeAddon(); screen.loadAddon(serializer as any)
      // Agents ask for attention with a bell or a desktop-notification escape
      // (OSC 9 `message`, OSC 777 `notify;title;body`).
      screen.onBell(() => this.emit('attention', { id, message: '' }))
      screen.parser.registerOscHandler(9, data => { if (!/^\d+;/.test(data)) this.emit('attention', { id, message: data }); return true })
      screen.parser.registerOscHandler(777, data => { const [kind, title = '', body = ''] = data.split(';'); if (kind === 'notify') this.emit('attention', { id, message: body || title }); return true })
      const env = Object.fromEntries(Object.entries(agentEnvironment()).filter(([, v]) => typeof v === 'string')) as Record<string,string>
      for (const [key, value] of Object.entries(extraEnv)) if (typeof value === 'string' && value) env[key] = value
      const executable = kind === 'shell' ? shellExecutable() : profile!.executable
      const args = kind === 'shell' ? ['-l'] : profile!.args
      const pty = spawn(executable, args, { name:'xterm-256color', cols, rows, cwd:repo, env:{...env, TERM:'xterm-256color',COLORTERM:'truecolor'} })
      let resolveExit!: () => void
      entry = { pty, screen, serializer, seq:0, alive:true, exited: new Promise<void>(r => { resolveExit = r }), resolveExit }
      this.entries.set(id, entry)
      const live = entry
      pty.onData(data => { screen.write(data, () => { live.seq++; this.emit('data', { id, data, seq:live.seq }) }) })
      pty.onExit(({exitCode}) => { live.alive=false; live.resolveExit(); this.emit('exit', {id,exitCode}); })
    }
    // Serialize after writes already queued at the time of attachment.
    await new Promise<void>(resolve => entry!.screen.write('', resolve))
    return { data: entry.serializer.serialize(), seq:entry.seq, cols:entry.screen.cols,rows:entry.screen.rows,running:entry.alive }
  }
  write(id:string,data:string) { const e=this.entries.get(id); if(e?.alive && typeof data==='string' && data.length<=1_000_000) { e.pty.write(data); this.emit('input', { id, data }) } }
  /** Latest screen text for an entry, including ones already exited. Used to
   *  explain an agent that exited before the terminal attached; empty when
   *  there is nothing to read. */
  screenText(id:string) {
    const e=this.entries.get(id)
    if(!e) return ''
    try { return e.serializer.serialize().slice(-8000) } catch { return '' }
  }
  resize(id:string,cols:number,rows:number) { const e=this.entries.get(id); if(!e?.alive || !Number.isInteger(cols)||!Number.isInteger(rows))return; cols=Math.max(20,Math.min(400,cols));rows=Math.max(5,Math.min(200,rows));if(e.screen.cols===cols&&e.screen.rows===rows)return;e.screen.resize(cols,rows);e.pty.resize(cols,rows) }
  async stop(id:string) {
    const e=this.entries.get(id)
    if(!e?.alive)return
    try { e.pty.kill('SIGTERM') } catch { return }
    const exited=e.exited
    const gentle=await Promise.race([exited.then(()=>true as const),new Promise<false>(resolve=>{const t=setTimeout(()=>resolve(false),1200);t.unref()})])
    if(gentle||!e.alive)return
    // Full-screen TUIs can trap SIGTERM (or wait on a child that does). Escalate
    // instead of leaving the canvas tile stuck with a retry loop.
    try { e.pty.kill('SIGKILL') } catch { /* the exit event still reconciles state */ }
    await Promise.race([exited,new Promise<void>(resolve=>{const t=setTimeout(resolve,2000);t.unref()})])
  }
  close() { for(const e of this.entries.values()){if(e.alive)e.pty.kill('SIGTERM');e.screen.dispose()}this.entries.clear() }
}
