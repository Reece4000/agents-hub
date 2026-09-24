import { existsSync } from 'node:fs'
import type { ApprovalMode } from './generated/msp'

export type CliApprovalMode = 'untrusted' | 'on-request' | 'never'
export type CliReasoningEffort = '' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

export interface LaunchOptions {
  model: string
  reasoningEffort: CliReasoningEffort
  approvalMode: CliApprovalMode
  permissionProfile: string
  trustWorkspace: boolean
  yolo: boolean
}

export const DEFAULT_LAUNCH: LaunchOptions = {
  model: '',
  reasoningEffort: '',
  approvalMode: 'on-request',
  permissionProfile: '',
  trustWorkspace: false,
  yolo: false,
}

export const CLI_APPROVAL_MODES: CliApprovalMode[] = ['untrusted', 'on-request', 'never']
export const CLI_REASONING_EFFORTS: CliReasoningEffort[] = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const MSP_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra'])

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function normalizeLaunch(input: unknown): LaunchOptions {
  const raw = (input ?? {}) as Partial<Record<keyof LaunchOptions, unknown>>
  const model = asString(raw.model).trim().slice(0, 200)
  const effort = asString(raw.reasoningEffort)
  const reasoningEffort: CliReasoningEffort = (CLI_REASONING_EFFORTS as string[]).includes(effort)
    ? (effort as CliReasoningEffort)
    : ''
  const approvalMode: CliApprovalMode = (CLI_APPROVAL_MODES as string[]).includes(asString(raw.approvalMode))
    ? (asString(raw.approvalMode) as CliApprovalMode)
    : 'on-request'
  const permissionProfile = asString(raw.permissionProfile).trim().slice(0, 200)
  return {
    model,
    reasoningEffort,
    approvalMode,
    permissionProfile,
    trustWorkspace: raw.trustWorkspace === true,
    yolo: raw.yolo === true,
  }
}

/** CLI approval flag → MSP wire mode (mirrors the Swift prototype mapping). */
export function wireApprovalMode(cli: CliApprovalMode): ApprovalMode {
  switch (cli) {
    case 'never': return 'allowAll'
    case 'untrusted': return 'denyUnmatched'
    default: return 'promptUnmatched'
  }
}

/** Stored effort → MSP turn/start tier, or undefined when the server default applies.
 *  `max` has no MSP tier, so chat maps it to `ultra` (the highest tier the wire
 *  protocol accepts); the terminal keeps the real `max` via CLI flags. */
export function mspReasoningEffort(effort: string): string | undefined {
  if (effort === 'max') return 'ultra'
  return MSP_EFFORTS.has(effort) ? effort : undefined
}

/** Flags shared by every `muse` launch, ending with `--workspace <repo>`. */
export function globalArguments(launch: LaunchOptions, repoPath: string): string[] {
  const args: string[] = []
  if (launch.model) args.push('--model', launch.model)
  if (launch.reasoningEffort) args.push('--reasoning-effort', launch.reasoningEffort)
  args.push('--approval-mode', launch.approvalMode)
  if (launch.permissionProfile) args.push('--permission-profile', launch.permissionProfile)
  if (launch.trustWorkspace) args.push('--trust-workspace')
  if (launch.yolo) args.push('--yolo')
  args.push('--workspace', repoPath)
  return args
}

/** Full argv for `muse resume <sessionId> …` (root options may follow the subcommand). */
export function terminalArguments(sessionId: string, repoPath: string, launch: LaunchOptions): string[] {
  return ['resume', sessionId, ...globalArguments(launch, repoPath)]
}

/** Interactive login shell for plain command terminals. `$SHELL` wins; macOS/Linux fallbacks follow. */
export function shellExecutable(): string {
  const configured = process.env.SHELL
  if (configured && existsSync(configured)) return configured
  return ['/bin/zsh', '/bin/bash', '/bin/sh'].find(p => existsSync(p)) ?? '/bin/sh'
}

export function launchSummary(launch: LaunchOptions): string {
  const parts = [launch.model || 'default model']
  if (launch.reasoningEffort) parts.push(launch.reasoningEffort)
  parts.push(launch.approvalMode)
  if (launch.yolo) parts.push('yolo')
  else if (launch.trustWorkspace) parts.push('trusted')
  return parts.join(' · ')
}
