import type { Attachment, TerminalResource } from './types'

/** Quote a filesystem path the way Muse's `@` file references expect. */
export function quoteTerminalPath(path: string): string {
  return `@"${path.replace(/"/g, '\\"')}"`
}

/** Build the exact bytes a rich terminal prompt sends to the PTY.
 *  Text first, then one `@"path"` token per attachment that has a saved path.
 *  Attachments without a path (unsaved preview-only rows) are skipped so a send
 *  can never silently drop a file the TUI would need. */
export function buildTerminalPrompt(text: string, attachments: Attachment[]): string {
  const refs = attachments
    .filter(a => typeof a.path === 'string' && a.path.length > 0)
    .map(a => quoteTerminalPath(a.path!))
  const body = [text.trim(), ...refs].filter(Boolean).join('\n')
  return body ? `${body}\n` : ''
}

/** Wrap a paste in bracketed-paste markers so multiline prompts arrive as one
 *  paste instead of line-by-line Enter submissions. */
export function bracketedPaste(payload: string): string {
  return `\x1b[200~${payload}\x1b[201~`
}

/** Bottom-bar summary for the rich composer. Always shows model, reasoning
 *  effort, and launch flags so the TUI status line has a visible mirror that
 *  never collapses to just the model name. Mirrors server launchSummary. */
export function formatComposerSummary(session: Pick<TerminalResource, 'launch' | 'terminalKind'>): string {
  if (session.terminalKind === 'shell') return 'Shell'
  const launch = session.launch
  const model = launch?.model || 'default model'
  const effort = launch?.reasoningEffort || ''
  const parts = [model, effort || 'default effort', `approval ${launch?.approvalMode ?? 'on-request'}`]
  const profile = launch?.permissionProfile?.trim()
  if (profile) parts.push(`profile ${profile}`)
  if (launch?.yolo) parts.push('yolo')
  else if (launch?.trustWorkspace) parts.push('trusted')
  return parts.join(' · ')
}
