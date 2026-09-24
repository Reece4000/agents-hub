import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextFreshness } from '../server/freshness'
import type { BoardNote } from '../shared/board'

const context = (id: string, verifiedAt: string, paths: string[]): BoardNote => ({ id, kind: 'context', title: id, body: '', createdAt: verifiedAt, updatedAt: verifiedAt, updatedBy: 'agent', revision: '', sectionId: '', links: [], verifiedAt, evidence: paths.map(path => ({ path })) })

test('context goes stale when its evidence is committed or edited after verification, or deleted', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-hub-fresh-'))
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
  let when = hoursAgo(3)
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } })
  try {
    git('init', '-q')
    mkdirSync(join(repo, 'src'))
    for (const file of ['src/store.ts', 'src/view.ts', 'src/old.ts', 'README.md']) writeFileSync(join(repo, file), 'v1\n')
    git('add', '.'); git('commit', '-qm', 'one')
    const verified = hoursAgo(2)
    when = hoursAgo(1)
    writeFileSync(join(repo, 'src/store.ts'), 'v2\n'); git('commit', '-qam', 'two')
    writeFileSync(join(repo, 'README.md'), 'edited\n')
    const past = new Date(Date.now() - 2.5 * 3_600_000)
    utimesSync(join(repo, 'README.md'), past, past)
    rmSync(join(repo, 'src/old.ts'))
    const result = contextFreshness(repo, [
      context('AH-000000000001', verified, ['src/store.ts:42']),
      context('AH-000000000002', verified, ['src/view.ts']),
      context('AH-000000000003', verified, ['src/old.ts']),
      context('AH-000000000004', verified, ['src']),
      context('AH-000000000005', verified, ['README.md']),
    ])
    assert.deepEqual(result['AH-000000000001'].reasons, ['src/store.ts changed after this was verified'], 'a :line suffix still matches the file')
    assert.equal(result['AH-000000000002'].stale, false)
    assert.deepEqual(result['AH-000000000003'].reasons, ['src/old.ts no longer exists'])
    assert.equal(result['AH-000000000004'].stale, true, 'a directory is stale when a file inside it changed')
    assert.equal(result['AH-000000000005'].stale, false, 'an uncommitted edit made before verification does not count')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('outside git, freshness is unknown rather than stale', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-nogit-'))
  try { assert.deepEqual(contextFreshness(dir, [context('AH-000000000001', new Date().toISOString(), ['a.ts'])]), {}) }
  finally { rmSync(dir, { recursive: true, force: true }) }
})
