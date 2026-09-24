import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import type { TerminalKind, TerminalProfile } from '../src/types'

export const builtinAgents = {
  codex: { label: 'Codex', command: 'codex' },
  claude: { label: 'Claude Code', command: 'claude' },
  cursor: { label: 'Cursor Agent', command: 'cursor-agent' },
} as const

export type BuiltinAgent = keyof typeof builtinAgents
export const isBuiltinAgent = (kind: TerminalKind): kind is BuiltinAgent => kind in builtinAgents

export function resolveExecutable(command: string): string | null {
  if (!command || command.includes('\0')) return null
  const paths = isAbsolute(command) ? [command] : [
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(path => join(path, command)),
    join(homedir(), '.local', 'bin', command),
    join(homedir(), '.npm-global', 'bin', command),
    join('/opt/homebrew/bin', command),
    join('/usr/local/bin', command),
  ]
  for (const path of paths) {
    try { if (statSync(path).isFile()) { accessSync(path, constants.X_OK); return path } } catch { /* try another location */ }
  }
  return null
}

export function availableAgents() {
  return Object.entries(builtinAgents).map(([kind, value]) => ({ kind, label: value.label, executable: resolveExecutable(value.command) }))
}

export function nativeProfile(kind: BuiltinAgent, rawModel: unknown): TerminalProfile {
  const spec = builtinAgents[kind]
  const executable = resolveExecutable(spec.command)
  if (!executable) throw new Error(`${spec.label} is not installed or cannot be found. Install its CLI or choose another agent.`)
  const model = typeof rawModel === 'string' ? rawModel.trim() : ''
  if (model.length > 120 || /[\r\n\0]/.test(model)) throw new Error('Choose a valid model identifier.')
  return { label: spec.label, executable, args: model ? ['--model', model] : [] }
}

export function customProfile(label: unknown, rawExecutable: unknown, rawArgs: unknown): TerminalProfile {
  const name = typeof label === 'string' ? label.trim().slice(0, 80) : ''
  const command = typeof rawExecutable === 'string' ? rawExecutable.trim() : ''
  const argv = Array.isArray(rawArgs) ? rawArgs : []
  if (!name || !command || argv.length > 40 || argv.some(value => typeof value !== 'string' || value.length > 500 || value.includes('\0'))) throw new Error('Add an agent name, executable, and valid argument list.')
  const executable = resolveExecutable(command)
  if (!executable) throw new Error(`Could not find executable: ${command}`)
  return { label: name, executable, args: argv }
}
