import type { Session } from '../src/types'
import type { Item, SessionReadResult } from './generated/msp'

export function applyHistory(session: Session, result: SessionReadResult) {
  const history = result.history
  if (history.items?.length || (history.mode !== 'none' && !session.items.length)) session.items = history.items || []
  else if (history.snapshot?.state.items.length) session.items = history.snapshot.state.items
  session.historyNote = history.mode === 'none' && !session.items.length ? 'Checking saved transcript…' : undefined
  session.model = result.session.modelId ?? session.model
  session.loaded = true
  session.status = result.session.status === 'running' ? 'running' : 'idle'
  session.turnId = result.session.activeTurnId ?? undefined
  titleFromItems(session)
}
export function titleFromItems(session: Session) {
  const message = session.items.find(item => item.kind === 'userMessage' && (item.displayText || item.text))
  const excerpt = message ? (message.displayText || message.text || '').replace(/\s+/g, ' ').trim().slice(0, 280) : ''
  if (excerpt) session.preview = excerpt
  if (session.title !== 'New conversation' && !session.title.startsWith('Session ·')) return
  // A whitespace-only first message must not wipe the visible title: the
  // sidebar row would render as a blank entry.
  if (excerpt) session.title = excerpt.slice(0, 75)
}

/** Title and preview recovery from a CLI-exported transcript. Mirrors
 *  titleFromItems: never leaves a blank title behind. */
export function titleFromExport(session: Session, recovered: { items: Item[]; title?: string }) {
  const first = recovered.items.find(i => i.kind === 'userMessage')
  const text = (first && (first.displayText || first.text) || '').replace(/\s+/g, ' ').trim()
  if (text) session.preview = text.slice(0, 280)
  if (recovered.title?.trim()) session.title = recovered.title
  else if (session.title.startsWith('Session ·') && text) session.title = text.slice(0, 75)
}
export function foldEvent(session: Session, method: string, params: any) {
  if (/^item\/(started|updated|completed)$/.test(method) && params.item) {
    const item = params.item as Item
    const index = session.items.findIndex(i => i.itemId === item.itemId)
    if (index < 0) session.items.push(item)
    else if (item.revision > session.items[index].revision || method === 'item/completed') session.items[index] = item
    titleFromItems(session)
  } else if (method === 'item/delta') {
    const item = session.items.find(i => i.itemId === params.itemId)
    if (!item) return
    const field = params.field ?? 'text'
    if (field.startsWith('summary.')) {
      const index = Number(field.split('.')[1]); if (!Number.isInteger(index) || index < 0 || index > 1000) return
      item.summary ??= []; item.summary[index] = (item.summary[index] ?? '') + params.delta
    } else if (field === 'output') item.visibleOutput = (item.visibleOutput ?? '') + params.delta
    else if (field === 'text') item.text = (item.text ?? '') + params.delta
    else if (field === 'args') item.args = (item.args ?? '') + params.delta
  } else if (method === 'turn/started') {
    session.status = 'running'; session.turnId = params.turnId; session.error = undefined
  } else if (method === 'turn/completed') {
    session.status = params.terminal === 'failed' ? 'error' : 'idle'
    session.turnId = undefined
    session.error = params.error?.message ?? (params.terminal === 'failed' ? params.reason ?? 'The turn failed. Your conversation is saved.' : undefined)
  } else if (method === 'approval/requested' || method === 'approval/updated') {
    session.approvals = [...session.approvals.filter(a => a.approvalId !== params.approvalId), params]
  } else if (method === 'approval/resolved') session.approvals = session.approvals.filter(a => a.approvalId !== params.approvalId)
  else if (method === 'userInput/requested') session.questions = [...session.questions.filter(q => q.userInputId !== params.userInputId), params]
  else if (method === 'userInput/settled') session.questions = session.questions.filter(q => q.userInputId !== params.userInputId)
  else if (method === 'session/modelChanged') session.model = params.modelId ?? params.model?.modelId ?? session.model
  if (method === 'turn/started' || method === 'turn/completed') session.updatedAt = new Date().toISOString()
}
