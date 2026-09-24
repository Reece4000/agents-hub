import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export class DictationService {
  private active: { child: ChildProcessWithoutNullStreams; resolveFinal: (value: string) => void; rejectFinal: (error: Error) => void; final: Promise<string> } | null = null

  async start(): Promise<void> {
    if (this.active) throw new Error('Dictation is already recording.')
    if (process.platform !== 'darwin') throw new Error('On-device dictation is available in the macOS app.')
    const executable = join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'dictate')
    if (!existsSync(executable)) throw new Error('The dictation helper is missing from this app build.')
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    let resolveFinal!: (value: string) => void, rejectFinal!: (error: Error) => void
    const final = new Promise<string>((resolve, reject) => { resolveFinal = resolve; rejectFinal = reject })
    void final.catch(() => {})
    const active = { child, resolveFinal, rejectFinal, final }
    this.active = active
    let ready = false, settled = false, buffer = '', lastError = ''
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Microphone permission or startup timed out.')) }, 35_000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk
        for (;;) {
          const end = buffer.indexOf('\n'); if (end < 0) break
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
          try {
            const event = JSON.parse(line) as { type: string; text?: string }
            if (event.type === 'ready' && !ready) { ready = true; clearTimeout(timer); resolve() }
            if (event.type === 'final' && !settled) { settled = true; resolveFinal(event.text ?? '') }
            if (event.type === 'error') { lastError = event.text || 'Transcription failed.'; if (!ready) { clearTimeout(timer); reject(new Error(lastError)) } else if (!settled) { settled = true; rejectFinal(new Error(lastError)) } }
          } catch { /* ignore malformed helper output */ }
        }
      })
      child.on('error', error => { clearTimeout(timer); if (!ready) reject(error); else if (!settled) { settled = true; rejectFinal(error) } })
      child.on('exit', code => { clearTimeout(timer); if (!ready) reject(new Error(lastError || `Dictation exited before recording (${code}).`)); else if (!settled) { settled = true; rejectFinal(new Error(lastError || 'Dictation stopped before producing text.')) } if (this.active === active) this.active = null })
    }).catch(error => { if (this.active === active) this.active = null; child.kill(); throw error })
  }

  async stop(): Promise<string> {
    const active = this.active
    if (!active) throw new Error('Dictation is not recording.')
    active.child.stdin.write('stop\n')
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([active.final, new Promise<string>((_, reject) => { timer = setTimeout(() => { active.child.kill(); reject(new Error('Transcription timed out.')) }, 8_000) })]) }
    finally { if (timer) clearTimeout(timer) }
  }

  cancel() { const active = this.active; this.active = null; if (active) { active.child.stdin.write('cancel\n'); active.child.kill() } }
  close() { this.cancel() }
}
