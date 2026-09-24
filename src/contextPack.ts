import type { BoardNote } from '../shared/board'

/** The text an agent receives for a context pack: each note's essentials. */
export function contextPack(notes: BoardNote[]) {
  const section = (note: BoardNote) => [
    `### ${note.kind === 'context' ? 'Codebase context' : note.kind === 'task' ? 'Task' : 'Note'} ${note.id}: ${note.title}${note.status ? ` (${note.status})` : ''}`,
    note.body.trim().slice(0, 1500),
    note.acceptance?.length ? `Acceptance:\n${note.acceptance.map(item => `- ${item}`).join('\n')}` : '',
    note.evidence?.length ? `Evidence: ${note.evidence.map(item => item.path).join(', ')}` : '',
    note.question ? `Open question: ${note.question.text}` : '',
  ].filter(Boolean).join('\n')
  return `Context from the Agent Hub board: ${notes.length} note${notes.length === 1 ? '' : 's'} the person selected for you. Use them as background for what they ask next; read any note with board_read for full detail. Reply with a one-line acknowledgement and wait for instructions.\n\n${notes.map(section).join('\n\n')}`
}
