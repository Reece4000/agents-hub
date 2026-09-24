import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
for (const arch of ['arm64','x64']) { const path = `node_modules/node-pty/prebuilds/darwin-${arch}/spawn-helper`; if (existsSync(path)) chmodSync(path, 0o755) }
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
await build({ entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'node-pty'], sourcemap: true })
await build({ entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
await build({ entryPoints: ['server/board-cli.ts'], outfile: 'dist-electron/board-cli.cjs', bundle: true, platform: 'node', format: 'cjs' })
if (process.platform === 'darwin') {
  const cache = join(process.cwd(), '.agent-hub', 'swift-cache')
  mkdirSync(cache, { recursive: true })
  execFileSync('swiftc', ['-module-cache-path', cache, 'native/Dictate.swift', '-o', 'dist-electron/dictate'], { stdio: 'inherit', env: { ...process.env, CLANG_MODULE_CACHE_PATH: cache, SWIFT_MODULE_CACHE_PATH: cache } })
}
