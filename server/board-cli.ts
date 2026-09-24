#!/usr/bin/env node
import { BoardAgent, boardTools } from './board-agent'

const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
const args = process.argv.slice(2)
const repo = process.env.AGENT_HUB_REPO || process.cwd()
let agent: BoardAgent
try { agent = new BoardAgent(repo, undefined, { sessionId: process.env.AGENT_HUB_SESSION_ID, terminalId: process.env.AGENT_HUB_TERMINAL_ID, actor: process.env.AGENT_HUB_AGENT_NAME }) }
catch (error) { process.stderr.write(`${(error as Error).message}\n`); process.exit(1) }

/** Answer with the client's protocol version when this server speaks it, else the newest one it does. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const negotiate = (requested: unknown) => typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0]

if (args[0] === 'mcp') {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    buffer += chunk
    if (buffer.length > 2_000_000) { process.stderr.write('MCP input too large.\n'); process.exit(1) }
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      if (!line.trim()) continue
      try {
        const request = JSON.parse(line)
        if (request.id === undefined) continue
        const result = request.method === 'initialize' ? { protocolVersion: negotiate(request.params?.protocolVersion), capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'agent-hub-board', version: '1.1.0' }, instructions: 'Agent Hub board: repository tasks, notes, and evidence-backed codebase facts. Start with board_summary; its activeTask is the Task your Session is working on.' }
          : request.method === 'tools/list' ? { tools: boardTools }
          : request.method === 'tools/call' ? (() => { try { return { content: [{ type: 'text', text: JSON.stringify(agent.call(request.params?.name, request.params?.arguments ?? {})) }] } } catch (error) { return { isError: true, content: [{ type: 'text', text: (error as Error).message }] } } })()
          : request.method === 'ping' ? {}
          : null
        if (result === null) write({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
        else write({ jsonrpc: '2.0', id: request.id, result })
      } catch (error) {
        let id: unknown = null
        try { id = JSON.parse(line).id ?? null } catch {}
        write({ jsonrpc: '2.0', id, error: { code: -32000, message: (error as Error).message } })
      }
    }
  })
  process.stdin.on('end', () => agent.close())
} else {
  const names: Record<string, string> = { summary: 'board_summary', search: 'board_search', read: 'board_read', related: 'board_related', log: 'board_log_progress', ask: 'board_ask', create: 'board_create_note', link: 'board_link_notes', attach: 'board_attach_image', 'update-task': 'board_update_task', 'upsert-context': 'board_upsert_context', 'complete-task': 'board_complete_task' }
  const action = names[args[0]]
  if (!action) {
    process.stdout.write(`Usage: agent-hub-board <${Object.keys(names).join('|')}|mcp> [JSON arguments]\n  agent-hub-board log "Found the cause"     append to the active Task's progress\n  agent-hub-board ask "Keep the old API?"   ask the person; the answer is typed into this terminal\nupdate-task and complete-task need expectedRevision from a fresh read. Set AGENT_HUB_REPO to the repository root.\n`)
    agent.close()
  } else {
    try {
      // Plain-text shorthands: `read ID`, `log some text`, `ask a question`.
      const raw = args.slice(1).join(' ')
      let input: unknown
      try { input = raw ? JSON.parse(raw) : {} } catch { input = raw }
      const plain = typeof input === 'string'
      if (plain && ['board_read', 'board_related'].includes(action)) write(agent.call(action, { id: input }))
      else if (plain && action === 'board_log_progress') write(agent.call(action, { text: input }))
      else if (plain && action === 'board_ask') write(agent.call(action, { question: input }))
      else write(agent.call(action, input as Record<string, unknown>))
    } catch (error) { process.stderr.write(`${(error as Error).message}\n`); process.exitCode = 1 }
    finally { agent.close() }
  }
}
