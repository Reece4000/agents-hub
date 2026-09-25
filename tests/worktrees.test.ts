import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HubService } from '../server/service'
import { WORKTREE_DIR } from '../server/worktrees'
import type { BoardNote } from '../shared/board'

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim()

test('fan-out gives each open subtask its own worktree, branch, Session, and agent', async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hub-fanout-')))
  const data = mkdtempSync(join(tmpdir(), 'agent-hub-fanout-data-'))
  const service = new HubService(data, repo)
  const opened: string[] = []
  service.terminals.open = (async (_id: string, cwd: string) => { opened.push(cwd); return { data: '', seq: 0, cols: 90, rows: 28, running: true } }) as typeof service.terminals.open
  try {
    git(repo, 'init', '-q'); writeFileSync(join(repo, 'app.ts'), 'export const a = 1\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init')
    const project = await service.invoke('project:create', { name: 'Drawer', folders: [repo] })
    const board = project.boardRoot
    service.boardStore.load(board)
    const parent = service.boardStore.apply(board, { type: 'createNote', note: { kind: 'task', title: 'Ship the drawer' } }) as BoardNote
    const make = (title: string) => service.boardStore.apply(board, { type: 'createNote', note: { kind: 'task', title, parentId: parent.id, links: [{ to: parent.id, kind: 'relates_to' }] } }) as BoardNote
    const first = make('Resize handle'), second = make('Keyboard toggle')
    await assert.rejects(service.invoke('board:fanout', { repo, taskId: first.id, terminalKind: 'custom', profile: { label: 'Env', executable: '/usr/bin/env', args: [] } }), /no open subtasks/)
    const result = await service.invoke('board:fanout', { repo, taskId: parent.id, terminalKind: 'custom', profile: { label: 'Env', executable: '/usr/bin/env', args: [] } })
    assert.equal(result.started.length, 2)
    const child = service.boardStore.query(board, { type: 'read', id: first.id }) as BoardNote
    assert.ok(child.worktree && existsSync(child.worktree.path) && child.worktree.path.startsWith(join(repo, WORKTREE_DIR)))
    assert.equal(git(child.worktree!.path, 'rev-parse', '--abbrev-ref', 'HEAD'), child.worktree!.branch)
    assert.equal(child.status, 'working')
    assert.ok(opened.includes(child.worktree!.path), 'the agent runs inside its worktree')
    const session = service.store.state.contexts.find(context => context.id === child.sessionId)!
    assert.equal(session.repo, repo, 'the Session belongs to the main repository board')
    assert.equal(session.terminals[0].cwd, child.worktree!.path)
    assert.match(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /\/\.agent-worktrees\//)
    assert.doesNotMatch(git(repo, 'status', '--porcelain', '--untracked-files=all'), /agent-worktrees/, 'worktrees never show as untracked in the main checkout')
    assert.match((service.boardStore.query(board, { type: 'read', id: parent.id }) as BoardNote).log?.at(-1)?.text ?? '', /Fanned out 2 subtasks/)

    writeFileSync(join(child.worktree!.path, 'app.ts'), 'export const a = 2\nexport const b = 3\n')
    git(child.worktree!.path, 'commit', '-qam', 'change')
    writeFileSync(join(child.worktree!.path, 'wip.ts'), 'x\n'); git(child.worktree!.path, 'add', 'wip.ts')
    const status = (await service.invoke('board:worktree:status', { repo }))[first.id]
    assert.deepEqual({ commits: status.commits, files: status.files, dirty: status.dirty }, { commits: 1, files: 2, dirty: true })
    await assert.rejects(service.invoke('board:worktree:remove', { repo, taskId: first.id }), /uncommitted changes/)
    await service.invoke('board:worktree:remove', { repo, taskId: first.id, force: true })
    assert.equal(existsSync(child.worktree!.path), false)
    assert.ok(git(repo, 'branch', '--list', child.worktree!.branch).includes(child.worktree!.branch), 'the branch survives removal')
  } finally { service.close(); rmSync(repo, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }) }
})
