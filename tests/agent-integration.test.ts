import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActivityTracker, describeTool, QUIET_MS } from '../server/agent-activity'
import { AgentEventServer } from '../server/agent-events'
import { HOOK_COMMAND, launchPlan, providerFor, writeBoardShim } from '../server/agent-integration'
import { BoardStore } from '../server/board-store'
import { BoardAgent } from '../server/board-agent'
import { agentEnvironment } from '../server/provider-profiles'
import type { AgentActivity } from '../src/types'

const tracker = () => {
  let now = 1_000_000
  const activity = new ActivityTracker(() => now)
  const seen: AgentActivity[] = []
  activity.on('change', (_id: string, value: AgentActivity) => seen.push(value))
  return { activity, seen, advance: (ms: number) => { now += ms } }
}

test('hook events drive Claude state: ready, thinking, tool detail, permission, finished', () => {
  const { activity } = tracker()
  activity.start('t', { hooks: true })
  assert.equal(activity.get('t')?.state, 'starting')
  activity.hook('t', { hook_event_name: 'SessionStart', session_id: 's-1', source: 'startup' })
  assert.deepEqual([activity.get('t')?.state, activity.get('t')?.detail], ['idle', 'Ready'])
  activity.hook('t', { hook_event_name: 'UserPromptSubmit', session_id: 's-1', prompt: 'fix it' })
  assert.equal(activity.get('t')?.state, 'working')
  activity.hook('t', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/repo/src/App.tsx' } })
  assert.equal(activity.get('t')?.detail, 'Editing App.tsx')
  activity.hook('t', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } })
  assert.deepEqual([activity.get('t')?.state, activity.get('t')?.detail], ['waiting', 'Approve running npm test'])
  activity.input('t', '1')
  assert.equal(activity.get('t')?.state, 'working', 'answering a prompt hands control back')
  activity.hook('t', { hook_event_name: 'Stop', last_assistant_message: 'All tests pass.\nDone.' })
  assert.deepEqual([activity.get('t')?.state, activity.get('t')?.detail], ['idle', 'All tests pass. Done.'])
  assert.equal(activity.get('t')?.source, 'hooks')
  assert.equal(activity.providerSession('t'), 's-1')
})

test('Codex turn completion and OSC 9 approvals map to idle and waiting', () => {
  const { activity } = tracker()
  activity.start('c', { hooks: true })
  activity.input('c', 'hello\r')
  activity.hook('c', { type: 'agent-turn-complete', 'thread-id': 'thread-9', 'last-assistant-message': 'Refactored the store.' })
  assert.deepEqual([activity.get('c')?.state, activity.get('c')?.detail], ['idle', 'Refactored the store.'])
  assert.equal(activity.providerSession('c'), 'thread-9')
  activity.input('c', 'next\r')
  assert.equal(activity.get('c')?.state, 'working')
  activity.attention('c', 'Approval requested: rm -rf build')
  assert.equal(activity.get('c')?.state, 'waiting')
})

test('without hooks, output means working and a quiet screen means idle; echo is ignored', async () => {
  const { activity, advance } = tracker()
  activity.start('x')
  activity.output('x')
  await new Promise(resolve => setTimeout(resolve, QUIET_MS + 50))
  assert.deepEqual([activity.get('x')?.state, activity.get('x')?.detail], ['idle', 'Ready'])
  activity.input('x', 'l')
  advance(50); activity.output('x')
  assert.equal(activity.get('x')?.state, 'idle', 'typing echo is not agent work')
  advance(1000); activity.output('x')
  assert.equal(activity.get('x')?.state, 'working')
  activity.attention('x')
  assert.equal(activity.get('x')?.state, 'waiting')
  activity.exit('x', 1)
  assert.deepEqual([activity.get('x')?.state, activity.get('x')?.detail], ['exited', 'Exited with code 1'])
  activity.forget('x')
})

test('tool descriptions stay short and readable', () => {
  assert.equal(describeTool('Bash', { command: 'npm run build && npm test -- --watch=false --reporter=spec --long-flag-value' }).length <= 68, true)
  assert.equal(describeTool('mcp__agent-hub__board_summary'), 'Updating the board')
  assert.equal(describeTool('Grep', { pattern: 'TODO' }), 'Searching TODO')
})

test('the event server accepts only tokened POSTs for a terminal', async () => {
  const received: Array<[string, unknown]> = []
  const server = new AgentEventServer((id, payload) => received.push([id, payload]))
  try {
    const url = await server.urlFor('res-1')
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify({ hook_event_name: 'Stop' }) })).status, 204)
    assert.equal((await fetch(url.replace(/token=\w+/, 'token=nope'), { method: 'POST', body: '{}' })).status, 404)
    assert.equal((await fetch(url, { method: 'GET' })).status, 404)
    await fetch(url, { method: 'POST', body: 'not json' })
    assert.deepEqual(received, [['res-1', { hook_event_name: 'Stop' }]])
  } finally { server.close() }
})

test('Claude launches with hooks, the board MCP server, and a resumable conversation id', () => {
  const board = { runtime: '/Apps/Agent Hub.app/Electron', cli: '/Apps/board-cli.cjs' }
  const fresh = launchPlan('claude', ['--model', 'haiku'], { repo: '/repo', sessionId: 'ctx-1', board, hookUrl: 'http://127.0.0.1:1/event?terminal=t&token=x' })
  assert.deepEqual(fresh.args.slice(0, 2), ['--model', 'haiku'], 'profile arguments come first')
  const mcp = JSON.parse(fresh.args[fresh.args.indexOf('--mcp-config') + 1])
  assert.deepEqual(mcp.mcpServers['agent-hub'], { type: 'stdio', command: board.runtime, args: [board.cli, 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1', AGENT_HUB_REPO: '/repo', AGENT_HUB_SESSION_ID: 'ctx-1' } })
  const settings = JSON.parse(fresh.args[fresh.args.indexOf('--settings') + 1])
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['Notification', 'PermissionRequest', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'])
  assert.equal(settings.hooks.Stop[0].hooks[0].command, HOOK_COMMAND)
  assert.deepEqual(settings.permissions, { allow: ['mcp__agent-hub'] }, 'only the board server is pre-approved')
  assert.deepEqual(fresh.args.slice(-2), ['--session-id', fresh.conversationId])
  assert.equal(fresh.env.AGENT_HUB_HOOK_URL, 'http://127.0.0.1:1/event?terminal=t&token=x')
  const resumed = launchPlan('claude', [], { repo: '/repo', sessionId: 'ctx-1', resumeId: 'abc-123' })
  assert.deepEqual(resumed.args, ['--resume', 'abc-123'], 'no hooks or MCP without an endpoint or board')
})

test('Codex launches with -c overrides for MCP, notify, and OSC 9 approvals, and resumes by thread id', () => {
  const plan = launchPlan('codex', ['--model', 'gpt-6-sol'], { repo: '/repo', sessionId: 'ctx-1', board: { runtime: '/e', cli: '/c.cjs' }, hookUrl: 'http://h/event?terminal=t&token=x', resumeId: 'thread-9' })
  assert.deepEqual(plan.args.slice(0, 4), ['resume', 'thread-9', '--model', 'gpt-6-sol'])
  const overrides = plan.args.filter((_, index) => plan.args[index - 1] === '-c')
  assert.ok(overrides.includes('mcp_servers.agent_hub.command="/e"'))
  assert.ok(overrides.includes('mcp_servers.agent_hub.args=["/c.cjs","mcp"]'))
  assert.ok(overrides.includes('mcp_servers.agent_hub.env={ELECTRON_RUN_AS_NODE="1",AGENT_HUB_REPO="/repo",AGENT_HUB_SESSION_ID="ctx-1"}'))
  assert.ok(overrides.some(value => value.startsWith('notify=["curl",') && value.endsWith('"http://h/event?terminal=t&token=x","--data-raw"]')))
  assert.ok(overrides.includes('tui.notification_method="osc9"'))
  assert.equal(plan.conversationId, 'thread-9')
})

test('only Claude and Codex, including custom profiles that run them, are integrated', () => {
  assert.equal(providerFor('claude'), 'claude')
  assert.equal(providerFor('custom', '/opt/homebrew/bin/codex'), 'codex')
  assert.equal(providerFor('custom', '/usr/bin/env'), null)
  assert.equal(providerFor('cursor', '/opt/homebrew/bin/cursor-agent'), null)
  assert.deepEqual(launchPlan(null, ['--x'], { repo: '/r', sessionId: 's', hookUrl: 'u' }).args, ['--x'])
})

test('the board shim runs the CLI with the Electron runtime and quotes paths with spaces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-shim-'))
  try {
    const bin = writeBoardShim(dir, { runtime: "/Apps/Agent Hub.app/Electron", cli: "/Apps/it's/board-cli.cjs" })
    const script = readFileSync(join(bin, 'agent-hub-board'), 'utf8')
    assert.match(script, /ELECTRON_RUN_AS_NODE=1 exec '\/Apps\/Agent Hub.app\/Electron' '\/Apps\/it'\\''s\/board-cli.cjs' "\$@"/)
    assert.equal(statSync(join(bin, 'agent-hub-board')).mode & 0o111, 0o111)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('agent board reads do not rewrite repo instruction files, and report the Session\'s working Task', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-hub-passive-'))
  const app = new BoardStore()
  try {
    app.load(repo)
    const task = app.apply(repo, { type: 'createNote', note: { kind: 'task', title: 'Wire hooks', status: 'working', sessionId: 'ctx-7' } }) as { id: string }
    app.close()
    writeFileSync(join(repo, 'CLAUDE.md'), 'user content only\n')
    const agent = new BoardAgent(repo, undefined, { sessionId: 'ctx-7' })
    try {
      const summary = agent.call('board_summary') as { activeTask: { id: string } | null }
      assert.equal(summary.activeTask?.id, task.id)
      assert.equal(readFileSync(join(repo, 'CLAUDE.md'), 'utf8'), 'user content only\n', 'agent reads never touch instruction files')
      assert.equal((new BoardAgent(repo, undefined, { sessionId: 'other' }).call('board_summary') as { activeTask: unknown }).activeTask, null)
    } finally { agent.close() }
    assert.ok(existsSync(join(repo, '.agents-hub', 'README.md')))
    assert.match(readFileSync(join(repo, '.agents-hub', 'README.md'), 'utf8'), /agent-hub-board summary/)
  } finally { app.close(); rmSync(repo, { recursive: true, force: true }) }
})

test('agent environments drop host-session markers but keep user configuration', () => {
  const saved = { ...process.env }
  try {
    Object.assign(process.env, { CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'host', AGENT_HUB_HOOK_URL: 'http://parent', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: 'm' })
    const env = agentEnvironment({ AGENT_HUB_REPO: '/repo' })
    for (const key of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'AGENT_HUB_HOOK_URL']) assert.equal(env[key], undefined, key)
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1')
    assert.equal(env.ANTHROPIC_MODEL, 'm')
    assert.equal(env.AGENT_HUB_REPO, '/repo', 'explicit values still apply')
  } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved) }
})
