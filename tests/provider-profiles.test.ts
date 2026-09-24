import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { customProfile, nativeProfile, resolveExecutable } from '../server/provider-profiles'

test('native and custom agent profiles resolve executables and keep argv separate', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-hub-profiles-'))
  const previous = process.env.PATH
  try {
    for (const name of ['codex', 'claude', 'cursor-agent', 'other-agent']) { const path = join(directory, name); writeFileSync(path, '#!/bin/sh\nexit 0\n'); chmodSync(path, 0o755) }
    process.env.PATH = directory
    assert.equal(resolveExecutable('cursor-agent'), join(directory, 'cursor-agent'))
    assert.deepEqual(nativeProfile('codex', 'small'), { label: 'Codex', executable: join(directory, 'codex'), args: ['--model', 'small'] })
    assert.deepEqual(nativeProfile('claude', ''), { label: 'Claude Code', executable: join(directory, 'claude'), args: [] })
    assert.deepEqual(customProfile('Other', 'other-agent', ['--mode', 'safe']), { label: 'Other', executable: join(directory, 'other-agent'), args: ['--mode', 'safe'] })
    assert.throws(() => nativeProfile('cursor', 'bad\nvalue'), /valid model/)
    assert.throws(() => customProfile('Missing', 'nonexistent-agent', []), /Could not find executable/)
  } finally { process.env.PATH = previous; rmSync(directory, { recursive: true, force: true }) }
})
