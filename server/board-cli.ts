#!/usr/bin/env node
import { BoardAgent, boardTools } from './board-agent'

const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
const args = process.argv.slice(2)
const repo = process.env.AGENT_HUB_REPO || process.cwd()
let agent: BoardAgent
try { agent = new BoardAgent(repo) }
catch (error) { process.stderr.write(`${(error as Error).message}\n`); process.exit(1) }

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
        const result = request.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'agent-hub-board', version: '1.0.0' } }
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
  const names: Record<string, string> = { summary: 'board_summary', search: 'board_search', read: 'board_read', related: 'board_related', 'update-task': 'board_update_task', 'upsert-context': 'board_upsert_context', 'complete-task': 'board_complete_task' }
  const action = names[args[0]]
  if (!action) {
    process.stdout.write('Usage: board-cli <summary|search|read|related|update-task|upsert-context|complete-task|mcp> [JSON arguments]\nMutations require expectedRevision. Set AGENT_HUB_REPO to the repository root.\n')
    agent.close()
  } else {
    try {
      const input = args[1] ? JSON.parse(args[1]) : {}
      if (['board_read', 'board_related'].includes(action) && typeof input === 'string') write(agent.call(action, { id: input }))
      else write(agent.call(action, input))
    } catch (error) { process.stderr.write(`${(error as Error).message}\n`); process.exitCode = 1 }
    finally { agent.close() }
  }
}
