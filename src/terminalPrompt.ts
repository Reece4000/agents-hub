import type { Attachment } from './types'

/** Escape a filesystem path the way a Finder drag into a terminal does
 *  (backslash before spaces and shell metacharacters). Agent CLIs already
 *  recognize dropped paths in this form, including image paths as images. */
export function quoteTerminalPath(path: string): string {
  return path.replace(/([\s\\'"`$&|;<>()\[\]{}*?!#~])/g, '\\$1')
}

/** Build the exact bytes a rich terminal prompt sends to the PTY.
 *  Text first, then one escaped path per attachment that has a saved path.
 *  Attachments without a path (unsaved preview-only rows) are skipped so a send
 *  can never silently drop a file the agent would need. */
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
