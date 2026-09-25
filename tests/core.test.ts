import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, newContext, newProject, emptyDraft } from '../server/store'
import type { TerminalResource } from '../src/types'

const terminal = (overrides: Partial<TerminalResource> = {}): TerminalResource => ({
  id: 'res-1', contextId: 'ctx-1', repo: '/tmp', name: 'Codex', agent: 'Codex', terminalKind: 'codex',
  profile: { label: 'Codex', executable: '/usr/local/bin/codex', args: ['--model', 'm1'] },
  draft: emptyDraft(), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...overrides,
})

test('reopening preserves context identity, name, draft, profile, and theme', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-hub-store-'))
  try {
    const first = new Store(directory, '/tmp')
    const project = newProject(directory, { name: 'Web', folders: ['/tmp', '/var/tmp'] })
    first.state.projects.push(project)
    const context = newContext('ctx-1', project.id, '/tmp', 'frontend', terminal())
    context.terminals[0].draft = { html: '<p>Review /debug</p>', text: 'Review /debug', attachments: [{ id: 'attachment', name: 'image.png', mime: 'image/png', size: 64 }] }
    first.state.contexts.push(context)
    first.state.selectedContexts = { [project.id]: 'ctx-1' }
    first.state.theme = 'light'; first.save()
    const second = new Store(directory)
    assert.deepEqual(second.state.contexts[0].terminals[0].draft, context.terminals[0].draft)
    assert.equal(second.state.contexts[0].id, context.id)
    assert.equal(second.state.contexts[0].name, 'frontend')
    assert.deepEqual(second.state.contexts[0].terminals[0].profile, context.terminals[0].profile)
    assert.deepEqual(second.state.selectedContexts, { [project.id]: 'ctx-1' })
    assert.deepEqual(second.state.projects.map(item => ({ name: item.name, folders: item.folders.map(folder => folder.path), boardRoot: item.boardRoot })), [{ name: 'Web', folders: ['/tmp', '/var/tmp'], boardRoot: join(directory, 'projects', project.id) }])
    assert.equal(second.state.contexts[0].projectId, project.id)
    assert.equal(second.state.theme, 'light')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('corrupt state surfaces an error instead of replacing user data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-hub-corrupt-'))
  try { writeFileSync(join(directory, 'workspace.json'), 'broken'); assert.throws(() => new Store(directory)) }
  finally { rmSync(directory, { recursive: true, force: true }) }
})

test('contexts persist whole and reopen with terminals stopped', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-hub-context-'))
  try {
    const first = new Store(directory, '/tmp')
    const context = newContext('ctx-1', 'prj-x', '/tmp', 'backend', terminal({ terminalRunning: true, draft: { html: '<p>Deploy</p>', text: 'Deploy', attachments: [] } }))
    first.state.contexts.push(context)
    first.save()
    const raw = JSON.parse(readFileSync(join(directory, 'workspace.json'), 'utf8'))
    assert.equal(raw.version, 2)
    assert.equal(raw.contexts[0].name, 'backend')
    assert.equal(raw.contexts[0].terminals[0].draft.text, 'Deploy')
    assert.equal(raw.contexts[0].terminals[0].terminalRunning, false, 'running state never reaches disk')
    const second = new Store(directory)
    assert.equal(second.state.contexts[0].name, 'backend')
    assert.equal(second.state.contexts[0].terminals[0].terminalRunning, false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('stored terminals of an unsupported kind reopen as custom with their command, or as a shell', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-hub-kinds-'))
  try {
    const stored = { version: 2, repos: ['/tmp'], selectedRepo: '/tmp', viewports: {}, theme: 'dark', contexts: [{ id: 'ctx-1', repo: '/tmp', name: 'old', launch: { model: 'm1' }, terminals: [
      { id: 'res-a', terminalKind: 'retired', name: 'Legacy agent', agent: 'Legacy', draft: emptyDraft(), launch: { model: 'm1' } },
      { id: 'res-b', terminalKind: 'retired', agent: 'Wrapped', profile: { label: 'Wrapped', executable: '/usr/bin/env', args: ['wrapped'] }, draft: emptyDraft() },
    ] }] }
    writeFileSync(join(directory, 'workspace.json'), JSON.stringify(stored))
    const store = new Store(directory, '/tmp')
    const [plain, wrapped] = store.state.contexts[0].terminals
    assert.equal(plain.terminalKind, 'shell')
    assert.equal(plain.name, 'Legacy agent')
    assert.equal(plain.profile, undefined)
    assert.equal(wrapped.terminalKind, 'custom')
    assert.deepEqual(wrapped.profile, { label: 'Wrapped', executable: '/usr/bin/env', args: ['wrapped'] })
    store.save()
    const raw = JSON.parse(readFileSync(join(directory, 'workspace.json'), 'utf8'))
    assert.ok(!('launch' in raw.contexts[0]) && !('launch' in raw.contexts[0].terminals[0]), 'retired launch flags are not written back')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('v1 workspace files are refused without being overwritten', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-hub-v1-'))
  try {
    const legacy = JSON.stringify({ version: 1, repos: ['/tmp'], sessions: [], selectedRepo: '/tmp', viewports: {}, theme: 'dark' })
    writeFileSync(join(directory, 'workspace.json'), legacy)
    assert.throws(() => new Store(directory, '/tmp'), /Unsupported/)
    assert.equal(readFileSync(join(directory, 'workspace.json'), 'utf8'), legacy)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('folder-based Sessions and repository boards migrate into one-folder projects', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-hub-migrate-projects-'))
  const repo = mkdtempSync(join(tmpdir(), 'agent-hub-migrate-repo-'))
  const boardOnly = mkdtempSync(join(tmpdir(), 'agent-hub-migrate-board-'))
  try {
    mkdirSync(join(repo, '.agents-hub', 'notes'), { recursive: true })
    mkdirSync(join(boardOnly, '.agents-hub', 'notes'), { recursive: true })
    const legacy = { version: 2, repos: [repo, boardOnly, '/tmp'], selectedRepo: repo, selectedContexts: { [repo]: 'ctx-1' }, viewports: {}, theme: 'dark',
      contexts: [{ id: 'ctx-1', repo, name: 'frontend', terminals: [{ id: 'res-1', terminalKind: 'shell', draft: emptyDraft() }] }, { id: 'ctx-2', repo, name: 'backend', terminals: [] }] }
    writeFileSync(join(directory, 'workspace.json'), JSON.stringify(legacy))
    const store = new Store(directory, repo)
    const [first, second] = store.state.projects
    assert.equal(store.state.projects.length, 2, 'a folder with Sessions and a folder with only a board each become a project; plain folders do not')
    assert.deepEqual(first.folders.map(folder => folder.path), [repo])
    assert.equal(first.importFrom, repo, 'the repository board is copied in on first use')
    assert.deepEqual(second.folders.map(folder => folder.path), [boardOnly])
    assert.deepEqual(store.state.contexts.map(context => context.projectId), [first.id, first.id])
    assert.equal(store.state.selectedProject, first.id)
    assert.deepEqual(store.state.selectedContexts, { [first.id]: 'ctx-1' })
  } finally { for (const dir of [directory, repo, boardOnly]) rmSync(dir, { recursive: true, force: true }) }
})
