import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import type { BoardNote } from '../shared/board'

/** Why a Codebase context note may no longer be true. */
export interface Freshness { stale: boolean; reasons: string[]; verifiedAt: string }

const git = (repo: string, args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })
/** Evidence paths may carry a `:line` or `#symbol` suffix; only the file part is checked. */
const evidenceFile = (path: string) => normalize(path.trim().replace(/[#:][^/]*$/, '')).replace(/^\.\/+/, '').replace(/\/+$/, '')

/** Check each context note's evidence files against git: a file committed
 *  or edited after the note was last verified, or one that no longer exists,
 *  makes the note stale. Returns nothing for repositories outside git. One
 *  `git log` since the oldest verification covers every note. */
export function contextFreshness(repo: string, notes: BoardNote[], now = new Date()): Record<string, Freshness> {
  const contexts = notes.filter(note => note.kind === 'context' && note.evidence?.length)
  if (!contexts.length) return {}
  const verified = (note: BoardNote) => note.verifiedAt || note.updatedAt
  const oldest = contexts.map(verified).sort()[0]
  // Dates are compared as UTC ISO strings, so git's offset dates are normalized.
  const changed = new Map<string, string>()
  try {
    // Newest first: the first date seen for a path is its latest change.
    let date = ''
    for (const line of git(repo, ['log', `--since=${oldest}`, '--format=%x00%cI', '--name-only', '--no-renames']).split('\n')) {
      if (line.startsWith('\0')) date = new Date(line.slice(1)).toISOString()
      else if (line && date && !changed.has(line)) changed.set(line, date)
    }
    // Uncommitted edits count from the file's modification time, so a fact
    // verified after an edit in the same task stays fresh.
    for (const entry of git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=no']).split('\0')) {
      const path = entry.slice(3)
      if (!path || entry.length <= 3) continue
      try { changed.set(path, statSync(join(repo, path)).mtime.toISOString()) } catch { changed.set(path, now.toISOString()) }
    }
  } catch { return {} }
  const result: Record<string, Freshness> = {}
  for (const note of contexts) {
    const since = verified(note)
    const reasons: string[] = []
    for (const item of note.evidence ?? []) {
      const file = evidenceFile(item.path)
      if (!file || file.startsWith('..')) continue
      if (!existsSync(join(repo, file))) { reasons.push(`${file} no longer exists`); continue }
      const latest = [...changed].filter(([path]) => path === file || path.startsWith(`${file}/`)).map(([, when]) => when).sort().at(-1)
      if (latest && latest > since) reasons.push(`${file} changed after this was verified`)
    }
    result[note.id] = { stale: reasons.length > 0, reasons, verifiedAt: since }
  }
  return result
}
