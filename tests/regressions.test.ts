import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MuseService } from '../server/service'
import { newRecord, newContext } from '../server/store'
import { applyHistory } from '../server/fold'
import type { MspClient } from '../server/msp'

test('typing a 100-key draft does not broadcast or synchronously serialize the entire workspace per key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-typing-'))
  const host = Object.assign(new EventEmitter(), { stop() {} }) as MspClient
  const service = new MuseService(dir, dir, host)
  try {
    service.store.state.contexts.push(newContext('ctx-draft', dir, 'frontend'))
    let writes = 0, broadcasts = 0
    service.store.save = () => { writes++ }
    service.on('workspace', () => { broadcasts++ })
    for (let i = 1; i <= 100; i++) await service.invoke('patchContext', { id: 'ctx-draft', patch: { draft: { html: `<p>${'a'.repeat(i)}</p>`, text: 'a'.repeat(i), attachments: [] } } })
    assert.equal(service.store.context('ctx-draft').draft.text.length, 100)
    assert.equal(broadcasts, 0, 'typing must remain local to the composer')
    assert.ok(writes <= 1, `100 keystrokes caused ${writes} full-store writes`)
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('creating and opening a context never contacts Muse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-empty-'))
  let calls = 0
  const host = Object.assign(new EventEmitter(), { stop() {}, async start() { return { serverInfo: { version: 'test' } } }, async request(method: string) { calls++; throw new Error(`contexts must not contact Muse (got ${method})`) } }) as unknown as MspClient
  const service = new MuseService(dir, dir, host)
  const original = service.terminals.open.bind(service.terminals)
  service.terminals.open = (async () => ({ data: '', seq: 0, cols: 90, rows: 28, running: true })) as typeof original
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'frontend' })
    await service.invoke('terminalOpen', { id: context.id })
    service.terminals.emit('exit', { id: context.id, exitCode: 0 })
    assert.equal(calls, 0, 'contexts own no Muse session to mint, read, or adopt')
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('a missing structured projection does not label recovered cached messages unavailable', () => {
  const s = newRecord('old', '/tmp', 0)
  s.items = [{ itemId:'message', kind:'userMessage', text:'Saved prompt', revision:1, status:'completed' }]
  applyHistory(s, { session:{sessionId:'old',status:'idle'}, history:{mode:'none', noneReason:'projectionUnavailable', items:null,snapshot:null} } as any)
  assert.equal(s.items.length,1)
  assert.equal(s.historyNote,undefined)
})

import { viewportShowsNodes } from '../src/viewport'
import { Store } from '../server/store'
import { Terminals } from '../server/terminals'
test('offscreen saved viewport is rejected, including negative coordinates and low zoom', () => {
  const nodes=[{position:{x:120,y:180},width:600,height:500}]
  assert.equal(viewportShowsNodes({x:-5000,y:-5000,zoom:1},nodes,1200,800),false)
  assert.equal(viewportShowsNodes({x:0,y:0,zoom:1},nodes,1200,800),true)
  assert.equal(viewportShowsNodes({x:100,y:100,zoom:.05},nodes,1200,800),true)
  assert.equal(viewportShowsNodes({x:NaN,y:0,zoom:1},nodes,1200,800),false)
})
test('contexts survive terminal exits and restarts, even when empty',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'agent-hub-keep-'))
  const host=Object.assign(new EventEmitter(),{stop(){}}) as MspClient
  const service=new MuseService(dir,dir,host)
  const original = service.terminals.open.bind(service.terminals)
  service.terminals.open = (async () => ({ data: '', seq: 0, cols: 90, rows: 28, running: true })) as typeof original
  try{
    // Only an explicit delete removes a context: empty drafts, closed
    // terminals, and restarts all keep it.
    const context=await service.invoke('newContext',{repo:dir,name:'backend'})
    await service.invoke('terminalOpen',{id:context.id})
    service.terminals.emit('exit',{id:context.id,exitCode:0})
    assert.equal(service.store.state.contexts.length,1)
    service.close()
    const restored=new Store(dir,dir)
    assert.equal(restored.state.contexts.length,1)
    assert.equal(restored.state.contexts[0].name,'backend')
  }finally{service.close();rmSync(dir,{recursive:true,force:true})}
})
test('PTY burst input survives and reattaching restores its existing screen', {timeout:5000},async()=>{
  const terminals=new Terminals({executable:'/bin/cat',args:[]})
  try{
    await terminals.open('test','test','/tmp',100,30)
    const marker='NO-DROPPED-KEYS-'+Array.from({length:200},(_,i)=>i%10).join('')
    const output=new Promise<void>(resolve=>{let all='';terminals.on('data',e=>{all+=e.data;if(all.includes(marker))resolve()})})
    for(const character of marker)terminals.write('test',character)
    terminals.write('test','\r');await output
    const screen=await terminals.open('test','test','/tmp',100,30)
    assert.ok(screen.data.includes('NO-DROPPED-KEYS-'))
    assert.equal(screen.running,true)
    await terminals.stop('test');assert.equal(terminals.running('test'),false)
  }finally{terminals.close()}
})
test('renaming a context persists and survives reopening', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-rename-'))
  const host = Object.assign(new EventEmitter(), { stop() {} }) as MspClient
  const service = new MuseService(dir, dir, host)
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'frontend' })
    await service.invoke('patchContext', { id: context.id, patch: { name: '  web  ' } })
    assert.equal(service.store.context(context.id).name, 'web')
    service.close()
    assert.equal(new Store(dir, dir).state.contexts[0].name, 'web')
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})
test('deleting a running context stops its PTY instead of hiding it while it runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-delete-stop-'))
  const host = Object.assign(new EventEmitter(), { stop() {} }) as MspClient
  const service = new MuseService(dir, dir, host)
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'infra' })
    service.store.context(context.id).terminalRunning = true
    let stopped: string | null = null
    service.terminals.stop = async (id: string) => { stopped = id }
    await service.invoke('deleteContext', { id: context.id })
    assert.equal(stopped, context.terminals[0].id)
    assert.equal(service.store.state.contexts.length, 0)
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})
test('deleteContext removes the context without waiting for PTY death', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-delete-fast-'))
  const host = Object.assign(new EventEmitter(), { stop() {} }) as MspClient
  const service = new MuseService(dir, dir, host)
  try {
    const context = await service.invoke('newContext', { repo: dir, name: 'frontend' })
    service.store.context(context.id).terminalRunning = true
    let stopCalled: string | null = null
    // A TUI mid-run can take seconds to shut down; the delete response (and
    // the tab removal it drives) must not wait on it.
    service.terminals.stop = ((id: string) => { stopCalled = id; return new Promise(() => {}) }) as typeof service.terminals.stop
    await Promise.race([
      service.invoke('deleteContext', { id: context.id }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('deleteContext waited for PTY death')), 3000)),
    ])
    assert.equal(stopCalled, context.terminals[0].id, 'shutdown is still initiated')
    assert.equal(service.store.state.contexts.length, 0)
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }) }
})
test('draft saves retain attachment metadata without copying image bytes on every keystroke',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'agent-hub-images-')),service=new MuseService(dir,dir)
  try{
    const context=await service.invoke('newContext',{repo:dir,name:'frontend'})
    const a=service.saveAttachment({name:'fixture.png',mime:'image/png',base64:Buffer.alloc(1024*1024,7).toString('base64')})
    await service.invoke('patchContext',{id:context.id,patch:{draft:{html:'<p>Image</p>',text:'Image',attachments:[a]}}})
    assert.equal(service.store.context(context.id).draft.attachments[0].preview,undefined)
    assert.equal(await service.invoke('attachmentPreview',{id:a.id,mime:a.mime}),a.preview)
  }finally{service.close();rmSync(dir,{recursive:true,force:true})}
})
