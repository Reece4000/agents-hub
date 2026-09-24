import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import electron from 'electron'
await import('./build-electron.mjs')
const server = await createServer({ server: { host: '127.0.0.1', port: 5173, strictPort: false } })
await server.listen()
const url = server.resolvedUrls.local[0]
console.log(`Agent Hub: ${url}`)
const electronEnv = { ...process.env, AGENT_HUB_DEV_URL: url, AGENT_HUB_PROJECT_ROOT: process.cwd() }
delete electronEnv.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['.'], { stdio: ['inherit', 'inherit', 'pipe'], env: electronEnv })
// Upstream Chromium menu validation can be chatty on macOS; keep the dev
// terminal usable by dropping that single known-noisy line.
child.stderr.on('data', data => {
  for (const line of String(data).split('\n')) {
    if (!line.trim()) continue
    if (line.includes('representedObject is not a WeakPtrToElectronMenuModelAsNSObject')) continue
    process.stderr.write(line + '\n')
  }
})
child.on('exit', async () => { await server.close(); process.exit() })
process.on('SIGINT', () => child.kill())
process.on('SIGTERM', () => child.kill())
