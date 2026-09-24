import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { DEFAULT_LAUNCH, type LaunchOptions } from '../server/launch'
import { resolveCustomProfile, resolveMuseProfile, resolveShellProfile } from '../server/profiles'

const launch: LaunchOptions = { ...DEFAULT_LAUNCH, model: 'm1' }

test('muse resume and bare launches resolve to distinct argv', () => {
  const resume = resolveMuseProfile('/usr/local/bin/muse', '/repo', launch, 'ses-1')
  assert.equal(resume.kind, 'muse')
  assert.equal(resume.executable, '/usr/local/bin/muse')
  assert.equal(resume.cwd, '/repo')
  assert.deepEqual(resume.args.slice(0, 2), ['resume', 'ses-1'])
  const fresh = resolveMuseProfile('/usr/local/bin/muse', '/repo', launch, null)
  assert.equal(fresh.args[0], '--model', 'fresh terminals launch bare so the TUI owns its session')
  assert.deepEqual(fresh.args.slice(0, 2), ['--model', 'm1'])
})

test('shell profiles never point at the Muse host', () => {
  const shell = resolveShellProfile('/bin/zsh', '/repo')
  assert.equal(shell.kind, 'shell')
  assert.deepEqual(shell.args, ['-l'])
  assert.equal(shell.cwd, '/repo')
})

test('custom profiles validate at creation, not at spawn', () => {
  const ok = resolveCustomProfile({ executable: process.execPath, args: ['--version'], cwd: tmpdir() })
  assert.equal(ok.kind, 'custom')
  assert.deepEqual(ok.args, ['--version'])
  assert.throws(() => resolveCustomProfile({ executable: 'relative/bin', cwd: tmpdir() }), /absolute path/)
  assert.throws(() => resolveCustomProfile({ executable: '/nonexistent/bin', cwd: tmpdir() }), /existing executable/)
  assert.throws(() => resolveCustomProfile({ executable: process.execPath, cwd: process.execPath }), /working directory/)
  assert.throws(() => resolveCustomProfile({ executable: process.execPath, args: 'nope' as unknown as string[], cwd: tmpdir() }), /array/)
  const many = resolveCustomProfile({ executable: process.execPath, args: Array.from({ length: 101 }, (_, i) => `a${i}`), cwd: tmpdir() })
  assert.equal(many.args.length, 100, 'argv arrays stay bounded')
})
