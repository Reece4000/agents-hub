import type { Item } from './generated/msp'

/** Read only the public transcript events from Muse's versioned local export.
 * Provider instructions, raw reasoning and encrypted reasoning are never displayed.
 */
export function exportedTranscript(document: unknown): { items: Item[]; title?: string } {
  const data = document as { export_schema_version?: number; events?: any[] }
  if (data.export_schema_version !== 1 || !Array.isArray(data.events)) throw new Error('This Muse export version is not supported.')
  const items: Item[] = []
  const seen = new Set<string>()
  const calls = new Map<string, Item>()
  let title: string | undefined
  for (const row of data.events) {
    if (row.kind !== 'record') continue
    const envelope = row.envelope ?? {}, payload = envelope.payload ?? {}, event = payload.event ?? {}
    if (envelope.payload_type === 'session.name.changed' && typeof payload.new_name === 'string') title = payload.new_name
    if (envelope.payload_type !== 'runtime.session') continue
    const id = String(envelope.id ?? '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    const common = { itemId: id, revision: 1, status: 'completed' as const, turnId: payload.run_id }
    if (payload.kind === 'run' && event.kind === 'started' && typeof event.prompt === 'string') {
      items.push({ ...common, kind: 'userMessage', text: event.prompt })
    } else if (event.kind === 'assistant_message_committed' && typeof event.text === 'string') {
      items.push({ ...common, itemId: event.message_id || id, kind: 'agentMessage', text: event.text })
    } else if (event.kind === 'assistant_tool_calls_committed' && Array.isArray(event.tool_calls)) {
      for (const call of event.tool_calls) {
        const item: Item = { ...common, itemId: call.call_id || call.id, kind: 'toolCall', tool: call.name, args: call.args }
        calls.set(call.call_id || call.id, item); items.push(item)
      }
    } else if (event.kind === 'tool_result_batch_committed' && Array.isArray(event.results)) {
      for (const result of event.results) {
        const item = calls.get(result.tool_call_id)
        if (item) item.visibleOutput = result.text
      }
    }
  }
  return { items, title }
}
