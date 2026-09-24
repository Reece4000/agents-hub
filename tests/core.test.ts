import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, newRecord, newContext, migrateSessions } from '../server/store'
import { foldEvent, applyHistory, titleFromItems, titleFromExport } from '../server/fold'
import type { SessionReadResult } from '../server/generated/msp'
import { exportedTranscript } from '../server/legacy-history'

test('legacy export restores public messages and linked tool results, excluding private reasoning', () => {
  const record = (id: string, event: object, kind = 'agent') => ({ kind: 'record', envelope: { id, payload_type: 'runtime.session', payload: { kind, run_id: 'turn', event } } })
  const user = record('user', { kind: 'started', prompt: 'Review this project' }, 'run')
  const result = exportedTranscript({ export_schema_version: 1, events: [
    user, user,
    record('private', { kind: 'reasoning_committed', text: 'private content' }),
    record('call', { kind: 'assistant_tool_calls_committed', tool_calls: [{ call_id: 'c1', name: 'shell', args: { command: 'pwd' } }] }),
    record('output', { kind: 'tool_result_batch_committed', results: [{ tool_call_id: 'c1', text: '/project' }] }),
    record('reply', { kind: 'assistant_message_committed', message_id: 'a1', text: 'Review complete' }),
    { kind: 'record', envelope: { payload_type: 'session.name.changed', payload: { new_name: 'Project review' } } }
  ] })
  assert.equal(result.title, 'Project review')
  assert.deepEqual(result.items.map(i => i.kind), ['userMessage', 'toolCall', 'agentMessage'])
  assert.equal(result.items[1].visibleOutput, '/project')
  assert.equal(result.items[2].text, 'Review complete')
  assert.throws(() => exportedTranscript({ export_schema_version: 2, events: [] }))
})

test('reopening preserves context identity, name, draft, launch flags, and theme', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-hub-store-'))
  try {
    const first = new Store(directory, '/tmp')
    const context = newContext('ctx-1', '/tmp', 'frontend')
    context.terminals[0].draft = { html: '<p>Review /debug</p>', text: 'Review /debug', attachments: [{ id: 'attachment', name: 'image.png', mime: 'image/png', size: 64 }] }
    context.terminals[0].launch = { model: 'm1', reasoningEffort: 'low', approvalMode: 'never', permissionProfile: '', trustWorkspace: false, yolo: false }
    first.state.contexts.push(context)
    first.state.selectedContexts = { '/tmp': 'ctx-1' }
    first.state.theme = 'light'; first.save()
    const second = new Store(directory)
    assert.deepEqual(second.state.contexts[0].terminals[0].draft, context.terminals[0].draft)
    assert.equal(second.state.contexts[0].id, context.id)
    assert.equal(second.state.contexts[0].name, 'frontend')
    assert.deepEqual(second.state.contexts[0].terminals[0].launch, context.terminals[0].launch)
    assert.deepEqual(second.state.selectedContexts, { '/tmp': 'ctx-1' })
    assert.equal(second.state.theme, 'light')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
test('corrupt state surfaces an error instead of replacing user data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-hub-corrupt-'))
  try { writeFileSync(join(directory, 'workspace.json'), 'broken'); assert.throws(() => new Store(directory)) }
  finally { rmSync(directory, { recursive: true, force: true }) }
})
test('streamed content survives duplicate starts; completed items replace it authoritatively', () => {
  const session = newRecord('s', '/tmp', 0)
  const initial = { itemId: 'reply', revision: 1, kind: 'agentMessage', status: 'inProgress', text: '' }
  foldEvent(session, 'item/started', { item: initial })
  foldEvent(session, 'item/delta', { itemId: 'reply', delta: 'Streaming text' })
  foldEvent(session, 'item/started', { item: { ...initial, text: '' } })
  assert.equal(session.items[0].text, 'Streaming text')
  foldEvent(session, 'item/completed', { item: { ...initial, revision: 2, text: 'Final text', status: 'completed' } })
  assert.equal(session.items[0].text, 'Final text')
  assert.equal(session.items.length, 1)
})
test('tool output and reasoning summary deltas use actual MSP fields', () => {
  const session = newRecord('s', '/tmp', 0)
  foldEvent(session, 'item/started', { item: { itemId: 'tool', revision: 1, kind: 'toolCall', status: 'inProgress', tool: 'shell' } })
  foldEvent(session, 'item/delta', { itemId: 'tool', field: 'output', delta: 'Passed' })
  foldEvent(session, 'item/delta', { itemId: 'tool', field: 'summary.0', delta: 'Summary' })
  assert.equal(session.items[0].visibleOutput, 'Passed'); assert.deepEqual(session.items[0].summary, ['Summary'])
})
test('contexts persist whole and reopen with terminals stopped', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-hub-context-'))
  try {
    const first = new Store(directory, '/tmp')
    const context = newContext('ctx-1', '/tmp', 'backend')
    context.terminals[0].draft = { html: '<p>Deploy</p>', text: 'Deploy', attachments: [] }
    context.terminals[0].terminalRunning = true
    first.state.contexts.push(context)
    first.save()
    const raw = JSON.parse(readFileSync(join(directory, 'workspace.json'), 'utf8'))
    assert.equal(raw.version, 2)
    assert.equal(raw.contexts[0].name, 'backend')
    assert.equal(raw.contexts[0].draft.text, 'Deploy')
    assert.equal(raw.contexts[0].terminalRunning, false, 'running state never reaches disk')
    assert.equal(raw.contexts[0].terminals[0].terminalRunning, false)
    assert.ok(!('sessions' in raw), 'v1 sessions are never written back')
    const second = new Store(directory)
    assert.equal(second.state.contexts[0].name, 'backend')
    assert.equal(second.state.contexts[0].terminalRunning, false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('v1 migration drops archived rows and Session placeholders, keeps named work as contexts', () => {
  const archived = { ...newRecord('old', '/tmp', 0), title: 'pastel-conjunction', activity: 'messages', archived: true } as never
  const placeholder = { ...newRecord('msp-1', '/tmp', 0), title: 'Session · deadbeef' }
  const named = { ...newRecord('msp-2', '/tmp', 0), title: 'basalt-mirfak', activity: 'messages', terminalKind: 'muse', launch: { model: 'm1', reasoningEffort: '', approvalMode: 'on-request', permissionProfile: '', trustWorkspace: false, yolo: false }, draft: { html: '<p>Hi</p>', text: 'Hi', attachments: [] } } as never
  const contexts = migrateSessions([archived, placeholder, named] as never)
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].id, 'msp-2')
  assert.equal(contexts[0].name, 'basalt-mirfak')
  assert.equal(contexts[0].draft.text, 'Hi')
  assert.equal(contexts[0].launch?.model, 'm1')
})

test('v1 workspace files migrate on open and save back as v2', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-hub-migrate-'))
  try {
    const legacy = { version: 1, repos: ['/tmp'], sessions: [{ ...newRecord('legacy', '/tmp', 0), title: 'gray-corvus', activity: 'messages' }, { ...newRecord('dead', '/tmp', 0), title: 'pastel', archived: true }], selectedRepo: '/tmp', viewports: {}, theme: 'dark', dismissedMuseIds: {} }
    writeFileSync(join(directory, 'workspace.json'), JSON.stringify(legacy))
    const restored = new Store(directory, '/tmp')
    assert.equal(restored.state.version, 2)
    assert.equal(restored.state.contexts.length, 1)
    assert.equal(restored.state.contexts[0].name, 'gray-corvus')
    restored.save()
    const raw = JSON.parse(readFileSync(join(directory, 'workspace.json'), 'utf8'))
    assert.equal(raw.version, 2)
    assert.ok(!('sessions' in raw) && !('dismissedMuseIds' in raw))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('history reconstructs conversation contents instead of opening a blank terminal', () => {
  const session = newRecord('s', '/tmp', 0)
  applyHistory(session, { session: { sessionId: 's', modelId: 'model', status: 'idle', activeTurnId: null }, history: { mode: 'inline', items: [{ itemId: 'old', kind: 'userMessage', text: 'The previous conversation', revision: 1, status: 'completed' }] } } as SessionReadResult)
  assert.equal(session.items[0].text, 'The previous conversation')
  assert.equal(session.title, 'The previous conversation'); assert.equal(session.loaded, true)
})

test('a whitespace-only first message keeps the placeholder title instead of blanking the row', () => {
  const session = newRecord('s', '/tmp', 0)
  titleFromItems(Object.assign(session, { items: [{ itemId: 'm1', kind: 'userMessage', status: 'completed', revision: 1, text: '   ' }] }))
  assert.equal(session.title, 'New conversation')
  assert.equal(session.preview, undefined)
})

test('export recovery never leaves a blank title or preview', () => {
  const blank = newRecord('s', '/tmp', 0)
  blank.title = 'Session · deadbeef'
  titleFromExport(blank, { items: [{ itemId: 'm1', kind: 'userMessage', status: 'completed', revision: 1, text: '  ' } as never] })
  assert.equal(blank.title, 'Session · deadbeef')
  assert.equal(blank.preview, undefined)
  const named = newRecord('s', '/tmp', 0)
  named.title = 'Session · deadbeef'
  titleFromExport(named, { title: '  ', items: [{ itemId: 'm1', kind: 'userMessage', status: 'completed', revision: 1, text: '  Hello there  ' } as never] })
  assert.equal(named.title, 'Hello there')
  assert.equal(named.preview, 'Hello there')
  const codenamed = newRecord('s', '/tmp', 0)
  titleFromExport(codenamed, { title: 'cyan-lightyear', items: [{ itemId: 'm1', kind: 'userMessage', status: 'completed', revision: 1, text: 'How do I set yolo mode' } as never] })
  assert.equal(codenamed.title, 'cyan-lightyear')
})
