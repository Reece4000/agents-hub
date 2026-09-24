import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { globalArguments, normalizeLaunch, terminalArguments, type LaunchOptions } from './launch'
import type { ResourceKind } from '../src/types'

/** Phase 1 launch profiles (docs/PHASE-1-DESIGN.md §5). The backend resolves
 *  a stored intent into an executable-plus-argument-array profile; renderer
 *  input never becomes argv. Spawn always happens without a shell. */
export interface LaunchProfile {
  kind: ResourceKind
  executable: string
  args: string[]
  cwd: string
  env?: Record<string, string>
}

const MAX_ARGS = 100
const MAX_ARG_LENGTH = 4096

/** Muse reattach when the provider session id is known, bare launch with
 *  the launch flags otherwise (the TUI then creates and owns its session). */
export function resolveMuseProfile(executable: string, repo: string, launch: LaunchOptions, sessionId: string | null): LaunchProfile {
  const args = sessionId == null
    ? globalArguments(normalizeLaunch(launch), repo)
    : terminalArguments(sessionId, repo, normalizeLaunch(launch))
  return { kind: 'muse', executable, args, cwd: repo }
}

/** Plain login shell. Never contacts the Muse host. */
export function resolveShellProfile(executable: string, repo: string): LaunchProfile {
  return { kind: 'shell', executable, args: ['-l'], cwd: repo }
}

export interface CustomProfileInput {
  executable: string
  args?: unknown
  cwd: string
}

/** Generic coding CLI. Validated at creation so an unresolvable profile
 *  fails here with the reason, never at spawn time with a dead terminal. */
export function resolveCustomProfile(input: CustomProfileInput): LaunchProfile {
  const executable = String(input.executable ?? '').trim()
  if (!executable || !isAbsolute(executable) || !existsSync(executable)) {
    throw new Error('Choose an existing executable (absolute path).')
  }
  if (!input.cwd || !isAbsolute(input.cwd)) throw new Error('Choose an existing working directory.')
  let cwdIsDirectory = false
  try { cwdIsDirectory = statSync(input.cwd).isDirectory() } catch { cwdIsDirectory = false }
  if (!cwdIsDirectory) throw new Error('Choose an existing working directory.')
  const raw = input.args ?? []
  if (!Array.isArray(raw)) throw new Error('Arguments must be an array of strings.')
  const args = raw.slice(0, MAX_ARGS).map(String)
  if (args.some(a => a.length > MAX_ARG_LENGTH)) throw new Error('A single argument is too long.')
  return { kind: 'custom', executable, args, cwd: input.cwd }
}
