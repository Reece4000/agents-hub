import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HubService } from '../server/service'
import { launchPlan } from '../server/agent-integration'
import { contextFreshness, locateEvidence } from '../server/freshness'
import { BoardAgent } from '../server/board-agent'
import type { OpenSpec } from '../server/terminals'
import type { BoardNote } from '../shared/board'

const temp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `agent-hub-${name}-`)))
const cat = { label: 'Env', executable: '/usr/bin/env', args: [] }

test('an agent in a project starts in the primary folder and can use every other folder', async () => {
  const data = temp('proj-data'), web = temp('proj-web'), api = temp('proj-api')
  const service = new HubService(data, web)
  const calls: { cwd: string; spec: OpenSpec }[] = []
  service.terminals.open = (async (_id: string, cwd: string, spec: OpenSpec) => { calls.push({ cwd, spec }); return { data: '', seq: 0, cols: 90, rows: 28, running: true } }) as typeof service.terminals.open
  try {
    const project = await service.invoke('project:create', { name: 'Shop', description: 'Storefront and its API', folders: [{ path: web, label: 'web' }, { path: api, label: 'api', note: 'REST service' }] })
    const context = await service.invoke('newContext', { project: project.id, terminalKind: 'custom', profile: cat })
    assert.equal(context.projectId, project.id)
    await service.invoke('terminalOpen', { id: context.terminals[0].id })
    assert.equal(calls[0].cwd, web)
    assert.equal(calls[0].spec.env?.AGENT_HUB_PROJECT_FOLDERS, `${web}\n${api}`)
    assert.equal(calls[0].spec.env?.AGENT_HUB_BOARD_ROOT, join(data, 'projects', project.id))
    const manifest = JSON.parse(readFileSync(join(project.boardRoot, 'project.json'), 'utf8'))
    assert.deepEqual(manifest.folders.map((folder: { path: string }) => folder.path), [web, api], 'board tools learn the folders from project.json')
    assert.deepEqual(readdirSync(web).filter(name => /AGENTS|CLAUDE|GEMINI|agents-hub/.test(name)), [], 'the project leaves its folders untouched')
  } finally { service.close(); for (const dir of [data, web, api]) rmSync(dir, { recursive: true, force: true }) }
})

test('Claude and Codex get the other folders and a project briefing', () => {
  const context = { repo: '/data/projects/p', sessionId: 's', addDirs: ['/code/api', '/code/docs'], instructions: 'You are working in the Agent Hub project "Shop".' }
  const claude = launchPlan('claude', [], context).args
  assert.deepEqual(claude.slice(0, 3), ['--add-dir', '/code/api', '/code/docs'])
  assert.equal(claude[claude.indexOf('--append-system-prompt') + 1], context.instructions)
  const codex = launchPlan('codex', [], context).args
  assert.deepEqual(codex.slice(0, 4), ['--add-dir', '/code/api', '--add-dir', '/code/docs'])
  assert.ok(codex.includes(`developer_instructions=${JSON.stringify(context.instructions)}`))
})

test('a folder with a repository board seeds the project board once, and project edits persist', async () => {
  const data = temp('proj-import'), repo = temp('proj-import-repo'), extra = temp('proj-import-extra')
  const service = new HubService(data, repo)
  try {
    service.boardStore.load(repo)
    const legacy = service.boardStore.apply(repo, { type: 'createNote', note: { kind: 'task', title: 'Carried over' } }) as BoardNote
    service.boardStore.close()
    const project = await service.invoke('project:create', { folders: [repo] })
    assert.equal(project.name, repo.split('/').at(-1))
    const snapshot = await service.invoke('board:load', { repo: project.boardRoot })
    assert.ok(snapshot.notes.some((note: BoardNote) => note.id === legacy.id), 'the repository board was copied in')
    assert.equal(service.store.project(project.id).importFrom, undefined, 'only once')
    assert.ok(existsSync(join(repo, '.agents-hub', 'notes', `${legacy.id}.md`)), 'the repository copy is left in place')
    const updated = await service.invoke('project:update', { id: project.id, patch: { name: 'Renamed', folders: [{ path: extra }, { path: repo }] } })
    assert.deepEqual([updated.name, updated.folders.map((folder: { path: string }) => folder.path)], ['Renamed', [extra, repo]], 'reordering changes the primary folder')
    await assert.rejects(service.invoke('project:update', { id: project.id, patch: { folders: [] } }), /at least one folder/)
    await assert.rejects(service.invoke('project:update', { id: project.id, patch: { folders: ['/definitely/missing'] } }), /existing folder/)
    await service.invoke('newContext', { project: project.id, terminalKind: 'shell' })
    await service.invoke('project:delete', { id: project.id })
    assert.equal(service.store.state.projects.length, 0)
    assert.equal(service.store.state.contexts.length, 0, 'its Sessions go with it')
    assert.equal(existsSync(project.boardRoot), false)
    assert.equal(readdirSync(join(data, 'projects', 'deleted')).length, 1, 'the board is archived, not deleted')
  } finally { service.close(); for (const dir of [data, repo, extra]) rmSync(dir, { recursive: true, force: true }) }
})

test('evidence resolves to the project folder that holds it, and freshness checks each folder', () => {
  const web = temp('fresh-web'), api = temp('fresh-api')
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  const git = (cwd: string, date: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
  try {
    for (const [folder, file] of [[web, 'app.ts'], [api, 'server.ts']]) { git(folder, hoursAgo(3), 'init', '-q'); writeFileSync(join(folder, file), 'v1\n'); git(folder, hoursAgo(3), 'add', '.'); git(folder, hoursAgo(3), 'commit', '-qm', 'one') }
    writeFileSync(join(api, 'server.ts'), 'v2\n'); git(api, hoursAgo(1), 'commit', '-qam', 'two')
    const folders = [web, api]
    assert.deepEqual(locateEvidence(folders, 'server.ts'), { folder: api, file: 'server.ts' }, 'found in whichever folder has it')
    assert.deepEqual(locateEvidence(folders, `${api.split('/').at(-1)}/server.ts`), { folder: api, file: 'server.ts' }, 'a folder-name prefix picks the folder')
    assert.deepEqual(locateEvidence(folders, join(api, 'server.ts')), { folder: api, file: 'server.ts' }, 'absolute paths map to their folder')
    const note = (id: string, path: string): BoardNote => ({ id, kind: 'context', title: id, body: '', createdAt: '', updatedAt: hoursAgo(2), updatedBy: 'agent', revision: '', sectionId: '', links: [], verifiedAt: hoursAgo(2), evidence: [{ path }] })
    const result = contextFreshness(folders, [note('AH-000000000001', 'app.ts'), note('AH-000000000002', 'server.ts')])
    assert.equal(result['AH-000000000001'].stale, false)
    assert.deepEqual(result['AH-000000000002'].reasons, [`${api.split('/').at(-1)}/server.ts changed after this was verified`])
  } finally { for (const dir of [web, api]) rmSync(dir, { recursive: true, force: true }) }
})

test('board tools resolve relative screenshot paths against the primary folder', () => {
  const board = temp('proj-board'), primary = temp('proj-primary')
  try {
    writeFileSync(join(board, 'project.json'), JSON.stringify({ folders: [{ path: primary }, { path: '/elsewhere' }] }))
    mkdirSync(join(board, '.agents-hub'))
    const agent = new BoardAgent(board)
    try { assert.deepEqual(agent.folders(), [primary, '/elsewhere']) } finally { agent.close() }
  } finally { for (const dir of [board, primary]) rmSync(dir, { recursive: true, force: true }) }
})
