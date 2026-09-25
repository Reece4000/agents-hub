import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { TaskWorktree } from '../shared/board'

/** Folder inside the repository that holds agent worktrees. It is added to
 *  `.git/info/exclude`, so it never shows up as untracked, and sits under
 *  the repository so agent CLIs treat it as already trusted. */
export const WORKTREE_DIR = '.agent-worktrees'

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim()
const slug = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task'

/** The worktree folder must stay inside this repository's agent folder. */
export function assertWorktreePath(repo: string, path: string) {
  const root = resolve(repo, WORKTREE_DIR)
  if (!resolve(path).startsWith(`${root}${sep}`)) throw new Error('Worktree is outside this repository’s agent worktree folder.')
}

/** Create a branch and worktree for one Task, starting from the main
 *  checkout's current commit. */
export function createWorktree(repo: string, taskId: string, title: string): TaskWorktree {
  let common: string
  try { common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']) } catch { throw new Error('Fan-out needs a git repository with at least one commit.') }
  const base = git(repo, ['rev-parse', 'HEAD'])
  const exclude = join(common, 'info', 'exclude')
  mkdirSync(join(common, 'info'), { recursive: true })
  const excluded = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  if (!excluded.split('\n').includes(`/${WORKTREE_DIR}/`)) appendFileSync(exclude, `${excluded && !excluded.endsWith('\n') ? '\n' : ''}/${WORKTREE_DIR}/\n`)
  const name = `${slug(title)}-${taskId.slice(-6).toLowerCase()}`
  const path = join(repo, WORKTREE_DIR, name)
  const branch = `agent/${name}`
  if (existsSync(path)) throw new Error(`A worktree already exists at ${WORKTREE_DIR}/${name}.`)
  try { git(repo, ['worktree', 'add', '-b', branch, path, base]) }
  catch (error) { throw new Error(`Could not create worktree: ${String((error as { stderr?: string }).stderr || (error as Error).message).trim()}`) }
  return { path, branch, base }
}

export interface WorktreeStatus { exists: boolean; commits: number; files: number; insertions: number; deletions: number; dirty: boolean }

/** How far a Task's worktree has moved from where it started: commits on
 *  its branch plus committed and uncommitted line changes. */
export function worktreeStatus(repo: string, worktree: TaskWorktree): WorktreeStatus {
  assertWorktreePath(repo, worktree.path)
  if (!existsSync(worktree.path)) return { exists: false, commits: 0, files: 0, insertions: 0, deletions: 0, dirty: false }
  const commits = Number(git(worktree.path, ['rev-list', '--count', `${worktree.base}..HEAD`])) || 0
  const stat = git(worktree.path, ['diff', '--shortstat', worktree.base])
  const count = (pattern: RegExp) => Number(pattern.exec(stat)?.[1] ?? 0)
  const dirty = git(worktree.path, ['status', '--porcelain']).length > 0
  return { exists: true, commits, files: count(/(\d+) files? changed/), insertions: count(/(\d+) insertions?/), deletions: count(/(\d+) deletions?/), dirty }
}

/** Remove a Task's worktree folder. The branch is kept so its commits can
 *  still be merged or inspected. Refuses uncommitted work unless forced. */
export function removeWorktree(repo: string, worktree: TaskWorktree, force = false) {
  assertWorktreePath(repo, worktree.path)
  if (!existsSync(worktree.path)) { try { git(repo, ['worktree', 'prune']) } catch { /* nothing to prune */ } return }
  if (!force && git(worktree.path, ['status', '--porcelain']).length) throw new Error('This worktree has uncommitted changes. Commit them, or remove it anyway.')
  git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), worktree.path])
}
