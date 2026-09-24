import { useEffect, useMemo, useRef, useState, type FocusEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { bridge } from './bridge'
import { macShortcutToInput } from './terminalKeys'
import { buildXtermTheme } from './theme'
import type { ThemeMode } from './theme'
import TerminalComposer, { getTerminalDraft } from './TerminalComposer'
import type { TerminalResource, Attachment } from './types'

type Cached = { terminal: Terminal; fit: FitAddon; ready: boolean; seq:number; queue: {data:string;seq:number}[]; stop:()=>void }
const terminals = new Map<string,Cached>()
/** Release a deleted terminal's xterm instance and its event subscription. */
export function disposeTerminal(id: string) {
  const cached = terminals.get(id)
  if (!cached) return
  cached.stop(); cached.terminal.dispose(); terminals.delete(id)
}
const openTimeout = <T,>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Terminal open timed out. Try starting the terminal again.')), 20000)
  promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
})
/** A live terminal. Passing `patch` docks the rich prompt below it; files
 *  pasted or dropped on the screen then join that prompt's draft. */
export default function TerminalView({session,onError,patch,themeMode,themeBackground,themeAccent}:{session:TerminalResource;onError:(message:string)=>void;patch?:(id:string,changes:Partial<TerminalResource>)=>Promise<unknown>;themeMode?:ThemeMode;themeBackground?:string;themeAccent?:string}) {
  const container=useRef<HTMLDivElement>(null)
  const wrap=useRef<HTMLDivElement>(null)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [focused,setFocused]=useState(false)
  const running=!!session.terminalRunning
  // Green border while keyboard focus is anywhere inside the TUI or composer.
  const onFocus=(e:FocusEvent)=>{if(e.currentTarget.contains(e.target))setFocused(true)}
  const onBlur=(e:FocusEvent)=>{if(!e.currentTarget.contains(e.relatedTarget as Node|null))setFocused(false)}
  // One shared TUI theme: the custom background/accent over the resolved mode.
  // The single mounted view refreshes every cached terminal so background
  // sessions pick the new colours up before they are shown again.
  const tuiTheme=useMemo(()=>buildXtermTheme({background:themeBackground,accent:themeAccent,mode:themeMode??'dark'}),[themeBackground,themeAccent,themeMode])
  useEffect(()=>{for(const cached of terminals.values()){cached.terminal.options.theme={...tuiTheme}}},[tuiTheme])
  useEffect(()=>{
    if(!container.current || !bridge.desktop)return
    let cached=terminals.get(session.id)
    if(!running && !cached)return
    if(!cached) {
      const terminal=new Terminal({fontFamily:'Menlo, monospace',fontSize:12,lineHeight:1.15,cursorBlink:true,scrollback:3000,allowProposedApi:true,screenReaderMode:true,theme:tuiTheme})
      const fit=new FitAddon();terminal.loadAddon(fit)
      cached={terminal,fit,ready:false,seq:0,queue:[],stop:()=>{}}
      const c=cached
      terminal.onData(data=>bridge.terminalInput?.(session.id,data))
      // macOS editing shortcuts xterm.js would otherwise mistranslate (Cmd+Backspace
      // arrives as a bare DEL). Returning false skips xterm handling for that key.
      const isMac=/Mac/.test(navigator.platform||'')||/Mac/.test(navigator.userAgent)
      terminal.attachCustomKeyEventHandler(e=>{
        if(e.type!=='keydown')return true
        const bytes=macShortcutToInput(e.key,{meta:e.metaKey,alt:e.altKey,ctrl:e.ctrlKey,shift:e.shiftKey},isMac)
        if(bytes===null)return true
        e.preventDefault();e.stopPropagation()
        bridge.terminalInput?.(session.id,bytes)
        return false
      })
      c.stop=bridge.onTerminal?.(event=>{
        if(event.id!==session.id)return
        if(event.data!==undefined&&event.seq!==undefined){if(!c.ready)c.queue.push({data:event.data,seq:event.seq});else if(event.seq>c.seq){c.seq=event.seq;terminal.write(event.data)}}
        if(event.exitCode!==undefined) { terminal.write(`\r\n[${session.agent} terminal exited: ${event.exitCode}]\r\n`); c.ready=false }
      })||(()=>{})
      terminals.set(session.id,c)
    }
    const c=cached
    if(c.terminal.element)container.current.appendChild(c.terminal.element)
    else c.terminal.open(container.current)
    // The composer docks below the screen in normal flow, so composer growth
    // shrinks this fit wrapper. Refit on every layout change and pin to the
    // bottom so the TUI status line never slides half under the composer.
    const resize=()=>{if(!container.current?.clientWidth || !container.current.clientHeight)return;c.fit.fit();try{c.terminal.scrollToBottom()}catch{}bridge.terminalResize?.(session.id,c.terminal.cols,c.terminal.rows)}
    if(!running)return
    let alive=true
    if (!c.ready) {
    c.queue=[]
    openTimeout(bridge.invoke<{data:string;seq:number;cols:number;rows:number}>('terminalOpen',{id:session.id})).then(snapshot=>{
      if(!alive)return
      c.terminal.resize(snapshot.cols,snapshot.rows);c.terminal.reset();c.terminal.write(snapshot.data,()=>{
        if(!alive)return
        c.seq=snapshot.seq;for(const event of c.queue){if(event.seq>c.seq){c.seq=event.seq;c.terminal.write(event.data)}}c.queue=[];c.ready=true;resize()
      })
    }).catch(e=>{setError(e.message);onError(e.message)})
    } else resize()
    const observer=new ResizeObserver(()=>{requestAnimationFrame(resize)});observer.observe(container.current);if(wrap.current)observer.observe(wrap.current)
    return()=>{alive=false;observer.disconnect()}
  },[session.id,running])
  const open=async(fresh=false)=>{setBusy(true);setError('');try{await openTimeout(bridge.invoke('terminalOpen',{id:session.id,fresh}))}catch(e){setError((e as Error).message);onError((e as Error).message)}finally{setBusy(false)}}
  // A terminal starts automatically the first time it is shown in this app
  // run. Once it has run, a stop or exit stays put: switching away and back
  // shows the closed screen instead of silently starting a fresh agent.
  useEffect(()=>{
    if(!bridge.desktop) return
    if(session.terminalRunning || terminals.has(session.id)) return
    let alive=true
    setBusy(true); setError('')
    openTimeout(bridge.invoke('terminalOpen',{id:session.id})).catch(e=>{ if(alive){setError((e as Error).message); onError((e as Error).message)} }).finally(()=>{ if(alive) setBusy(false) })
    return()=>{alive=false}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[session.id])
  const saveFiles = async (files: File[]) => {
    if (!files.length || !patch) return
    try {
      const saved: Attachment[] = []
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} is larger than 20 MB.`)
        const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(`Could not read ${file.name}`)); reader.readAsDataURL(file) })
        saved.push(await bridge.invoke<Attachment>('attachment', { name: file.name, mime: file.type || 'application/octet-stream', base64: dataUrl.split(',')[1] }))
      }
      const current = getTerminalDraft(session.id) ?? session.draft
      await patch(session.id, { draft: { ...current, attachments: [...current.attachments, ...saved] } })
    } catch (e) { setError((e as Error).message); onError((e as Error).message) }
  }
  // Files dropped or pasted over the terminal land in the rich prompt draft
  // (visible thumbnails) instead of being lost to the browser. Without a
  // prompt, everything falls through to xterm untouched.
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? [])
    if (files.length && patch) { e.preventDefault(); e.stopPropagation(); void saveFiles(files); return }
    if (bridge.desktop && patch && !e.clipboardData?.getData('text/plain') && !e.clipboardData?.getData('text/html')) {
      e.preventDefault(); e.stopPropagation()
      void bridge.invoke<Attachment[]>('clipboard').then(attachments => {
        if (!attachments.length) { onError('No image or file was found on the clipboard.'); return }
        const current = getTerminalDraft(session.id) ?? session.draft
        void patch(session.id, { draft: { ...current, attachments: [...current.attachments, ...attachments] } }).catch(err => onError((err as Error).message))
      }).catch(err => onError((err as Error).message))
    }
  }
  const onDrop = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (!files.length || !patch) return
    e.preventDefault(); e.stopPropagation(); void saveFiles(files)
  }
  return <div className={`terminal-wrap${focused?' terminal-focused':''}`} ref={wrap} onFocus={onFocus} onBlur={onBlur}>
  <div className="terminal-body" onPaste={onPaste} onDrop={onDrop}>
    {running || terminals.has(session.id) ? <div className="terminal-screen"><div ref={container} className="terminal-fit"/></div> : <div className="terminal-idle"><strong>{bridge.desktop?`${session.agent} terminal`:'Terminal preview'}</strong><p>{bridge.desktop?`Start ${session.agent} in ${session.repo}. Configure its command in the terminal profile when you add it.`:'Terminal processes run in the desktop app.'}</p><button className="small-button" disabled={busy||!bridge.desktop} onClick={()=>void open()}>{busy?'Starting…':'Open terminal'}</button></div>}
    {!running && terminals.has(session.id) && <div className="terminal-footer"><span>Terminal closed</span>{session.conversationId ? <><button className="small-button" disabled={busy} onClick={()=>void open(true)}>New conversation</button><button className="small-button" disabled={busy} onClick={()=>void open()}>Resume conversation</button></> : <button className="small-button" disabled={busy} onClick={()=>void open()}>Reopen terminal</button>}</div>}
    {error && <div className="inline-error">{error}</div>}
  </div>
  {patch && <TerminalComposer key={`prompt-${session.id}`} session={session} patch={patch} onError={onError} />}
  </div>
}
