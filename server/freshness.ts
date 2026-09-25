import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, normalize, relative } from 'node:path'
import type { BoardNote } from '../shared/board'

/** Why a Codebase context note may no longer be true. */
export interface Freshness { stale: boolean; reasons: string[]; verifiedAt: string }

const git = (repo: string, args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })
/** Evidence paths may carry a `:line` or `#symbol` suffix; only the file part is checked. */
const evidenceFile = (path: string) => normalize(path.trim().replace(/[#:][^/]*$/, '')).replace(/^\.\/+/, '').replace(/\/+$/, '')

/** Which project folder an evidence path belongs to, and its path there:
 *  an absolute path inside a folder, a path starting with a folder's name,
 *  a path that exists in some folder, or else the primary folder. */
export function locateEvidence(folders: string[], path: string): { folder: string; file: string } | null {
  if (!folders.length) return null
  const file = evidenceFile(path)
  if (isAbsolute(path)) {
    const folder = folders.find(item => file === item || file.startsWith(`${item}/`))
    return folder ? { folder, file: relative(folder, file) || '.' } : null
  }
  const [head, ...rest] = file.split('/')
  const named = folders.find(item => basename(item) === head)
  if (named && rest.length && !existsSync(join(folders[0], file))) return { folder: named, file: rest.join('/') }
  const found = folders.find(item => existsSync(join(item, file)))
  return { folder: found ?? folders[0], file }
}

/** Check each context note's evidence files against git in their project
 *  folder: a file committed or edited after the note was last verified, or
 *  one that no longer exists, makes the note stale. Folders outside git
 *  report nothing. One `git log` per folder covers every note. */
export function contextFreshness(folders: string[] | string, notes: BoardNote[], now = new Date()): Record<string, Freshness> {
  const roots = typeof folders === 'string' ? [folders] : folders
  const contexts = notes.filter(note => note.kind === 'context' && note.evidence?.length)
  if (!contexts.length || !roots.length) return {}
  const verified = (note: BoardNote) => note.verifiedAt || note.updatedAt
  const oldest = contexts.map(verified).sort()[0]
  const history = new Map(roots.map(root => [root, gitChanges(root, oldest, now)]))
  const result: Record<string, Freshness> = {}
  for (const note of contexts) {
    const since = verified(note)
    const reasons: string[] = []
    let known = false
    for (const item of note.evidence ?? []) {
      const located = locateEvidence(roots, item.path)
      if (!located || !located.file || located.file.startsWith('..')) continue
      const changed = history.get(located.folder)
      if (!changed) continue
      known = true
      const label = roots.length > 1 ? `${basename(located.folder)}/${located.file}` : located.file
      if (!existsSync(join(located.folder, located.file))) { reasons.push(`${label} no longer exists`); continue }
      const latest = [...changed].filter(([path]) => path === located.file || path.startsWith(`${located.file}/`)).map(([, when]) => when).sort().at(-1)
      if (latest && latest > since) reasons.push(`${label} changed after this was verified`)
    }
    if (known) result[note.id] = { stale: reasons.length > 0, reasons, verifiedAt: since }
  }
  return result
}

/** Latest change time per path in a git folder since `since`, or null
 *  outside git. Dates are UTC ISO strings, so git's offset dates are
 *  normalized. */
function gitChanges(repo: string, since: string, now: Date): Map<string, string> | null {
  const changed = new Map<string, string>()
  try {
    // Newest first: the first date seen for a path is its latest change.
    let date = ''
    // --relative keeps paths relative to this folder when it sits inside a larger repository.
    for (const line of git(repo, ['log', `--since=${since}`, '--format=%x00%cI', '--name-only', '--no-renames', '--relative']).split('\n')) {
      if (line.startsWith('\0')) date = new Date(line.slice(1)).toISOString()
      else if (line && date && !changed.has(line)) changed.set(line, date)
    }
    // Uncommitted edits count from the file's modification time, so a fact
    // verified after an edit in the same task stays fresh.
  } catch { return null }
  try {
    for (const path of git(repo, ['diff', '--name-only', '--relative', '-z', 'HEAD']).split('\0')) {
      if (!path) continue
      try { changed.set(path, statSync(join(repo, path)).mtime.toISOString()) } catch { changed.set(path, now.toISOString()) }
    }
  } catch { /* no commits yet */ }
  return changed
}
