import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Paperclip, X, File, ChevronDown, Loader2, RotateCcw } from 'lucide-react'
import { bridge } from './bridge'
import { buildTerminalPrompt, bracketedPaste, formatComposerSummary } from './terminalPrompt'
import type { TerminalResource, Skill, Attachment, Draft } from './types'

const drafts = new Map<string, () => Promise<unknown>>()
export const flushTerminalDraft = (id: string) => drafts.get(id)?.() ?? Promise.resolve()
const draftGetters = new Map<string, () => import('./types').Draft>()
export const getTerminalDraft = (id: string) => draftGetters.get(id)?.()

const EFFORTS = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export default function TerminalComposer({ session, skills, models, onError, patch }: {
  session: TerminalResource; skills: Skill[]; models: { modelId: string; displayLabel: string }[];
  onError: (error: string) => void; patch: (id: string, changes: Partial<TerminalResource>) => Promise<unknown>
}) {
  const [draft, setDraft] = useState<Draft>(session.draft)
  const draftRef = useRef(draft)
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [query, setQuery] = useState<string | null>(null)
  const [activeSkill, setActiveSkill] = useState(0)
  const [settings, setSettings] = useState(false)
  const [model, setModel] = useState(session.launch?.model ?? '')
  const [effort, setEffort] = useState<NonNullable<NonNullable<TerminalResource['launch']>['reasoningEffort']>>(session.launch?.reasoningEffort ?? '')
  const [applying, setApplying] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const composer = useRef<HTMLElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const submitRef = useRef<() => void>(() => {})
  const addFilesRef = useRef<(files: File[]) => void>(() => {})
  const clipboardRef = useRef<() => void>(() => {})
  const menuRef = useRef<{ matches: Skill[]; index: number; choose: (skill: Skill) => void }>({ matches: [], index: 0, choose: () => {} })
  const persist = useRef(patch)
  persist.current = patch
  const saveDraft = (next: Draft) => {
    draftRef.current = next; setDraft(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void persist.current(session.id, { draft: draftRef.current }).catch(e => onError(e.message)), 150)
  }
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false, codeBlock: false, link: { openOnClick: false } }), Placeholder.configure({ placeholder: 'Write a prompt, or / for skills…  Enter sends · Shift+Enter newline' })],
    content: session.draft.html || '',
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': 'Terminal prompt', 'aria-multiline': 'true', spellcheck: 'true' },
      handleKeyDown: (_view, event) => {
        const menu = menuRef.current
        if (menu.matches.length && ['ArrowDown', 'ArrowUp', 'Tab', 'Enter', 'Escape'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation()
          if (event.key === 'Escape') setQuery(null)
          else if (event.key === 'ArrowDown') setActiveSkill(i => (i + 1) % menu.matches.length)
          else if (event.key === 'ArrowUp') setActiveSkill(i => (i - 1 + menu.matches.length) % menu.matches.length)
          else menu.choose(menu.matches[menu.index] ?? menu.matches[0])
          return true
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submitRef.current(); return true }
        return false
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? [])
        if (files.length) { event.preventDefault(); addFilesRef.current(files); return true }
        if (bridge.desktop && !event.clipboardData?.getData('text/plain') && !event.clipboardData?.getData('text/html')) {
          event.preventDefault(); clipboardRef.current(); return true
        }
        return false
      },
      handleDrop: (_view, event) => {
        const files = Array.from(event.dataTransfer?.files ?? [])
        if (!files.length) return false
        event.preventDefault(); addFilesRef.current(files); return true
      },
    },
    onUpdate: ({ editor }) => {
      saveDraft({ ...draftRef.current, html: editor.getHTML(), text: editor.getText({ blockSeparator: '\n' }) })
      const before = editor.state.doc.textBetween(Math.max(0, editor.state.selection.from - 80), editor.state.selection.from, '\n')
      const match = before.match(/(?:^|\s)\/([\w:-]*)$/)
      setQuery(match ? match[1] : null); setActiveSkill(0)
    },
  })
  useEffect(() => {
    drafts.set(session.id, () => { clearTimeout(timer.current); timer.current = undefined; return persist.current(session.id, { draft: draftRef.current }) })
    draftGetters.set(session.id, () => draftRef.current)
    return () => {
      // A keystroke landing between the delete's draft flush and this unmount
      // re-arms the timer; persisting it then races the delete. Losing that
      // race is expected (the context is gone by design), so only surface
      // other errors.
      if (timer.current) { clearTimeout(timer.current); void persist.current(session.id, { draft: draftRef.current }).catch(e => { if (!/no longer available/.test((e as Error).message)) onError((e as Error).message) }) }
      drafts.delete(session.id)
      draftGetters.delete(session.id)
    }
  }, [session.id])
  useEffect(() => { editor?.setEditable(!sending) }, [sending, uploading, editor])
  useEffect(() => { setModel(session.launch?.model ?? '') }, [session.launch?.model])
  useEffect(() => { setEffort(session.launch?.reasoningEffort ?? '') }, [session.launch?.reasoningEffort])
  useEffect(() => {
    let active = true
    const missing = draftRef.current.attachments.filter(a => !a.preview && /^image\//.test(a.mime))
    void Promise.all(missing.map(async a => ({ id: a.id, preview: await bridge.invoke<string | null>('attachmentPreview', { id: a.id, mime: a.mime }) }))).then(previews => {
      if (!active || !previews.length) return
      const next = { ...draftRef.current, attachments: draftRef.current.attachments.map(a => ({ ...a, preview: a.preview || previews.find(p => p.id === a.id)?.preview || undefined })) }
      draftRef.current = next; setDraft(next)
    }).catch(() => {})
    return () => { active = false }
  }, [session.id])
  const matches = query === null ? [] : skills.filter(s => `${s.name} ${s.description}`.toLowerCase().includes(query.toLowerCase())).slice(0, 7)
  useEffect(() => {
    if (!settings && !matches.length) return
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (!composer.current?.contains(target)) { setSettings(false); setQuery(null); return }
      if (!target.closest('.model-settings, .model-trigger')) setSettings(false)
      if (!target.closest('.skill-menu')) setQuery(null)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [settings, matches.length])
  const choose = (skill: Skill) => {
    if (!editor) return
    const end = editor.state.selection.from
    editor.chain().focus().insertContentAt({ from: end - (query?.length ?? 0) - 1, to: end }, `/${skill.name} `).run()
    setQuery(null)
  }
  menuRef.current = { matches, index: activeSkill, choose }
  const append = (attachments: Attachment[]) => saveDraft({ ...draftRef.current, attachments: [...draftRef.current.attachments, ...attachments] })
  addFilesRef.current = async files => {
    setUploading(true)
    try {
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} is larger than 20 MB.`)
        const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(`Could not read ${file.name}`)); reader.readAsDataURL(file) })
        append([await bridge.invoke<Attachment>('attachment', { name: file.name, mime: file.type || 'application/octet-stream', base64: dataUrl.split(',')[1] })])
      }
    } catch (e) { onError((e as Error).message) } finally { setUploading(false) }
  }
  clipboardRef.current = async () => {
    setUploading(true)
    try { const attachments = await bridge.invoke<Attachment[]>('clipboard'); if (attachments.length) append(attachments); else onError('No image or file was found on the clipboard.') }
    catch (e) { onError((e as Error).message) } finally { setUploading(false) }
  }
  submitRef.current = async () => {
    if (sending || uploading) return
    if (!bridge.terminalInput) { onError('Rich prompts need the desktop app.'); return }
    if (!session.terminalRunning) { onError('Open the terminal first, then send the prompt.'); return }
    const current = draftRef.current
    if (!current.text.trim() && !current.attachments.length) return
    clearTimeout(timer.current); setSending(true); setQuery(null)
    try {
      const resolved: Attachment[] = []
      for (const a of current.attachments) {
        if (a.path) { resolved.push(a); continue }
        try {
          const path = await bridge.invoke<string>('attachmentPath', { id: session.id, attachmentId: a.id })
          resolved.push({ ...a, path })
        } catch (e) { throw new Error(`Could not resolve ${a.name}: ${(e as Error).message}`) }
      }
      const payload = buildTerminalPrompt(current.text, resolved)
      if (!payload.trim()) throw new Error('Write a prompt or attach a file first.')
      await persist.current(session.id, { draft: current })
      bridge.terminalInput(session.id, bracketedPaste(payload.trimEnd()) + '\r')
      const cleared = { html: '', text: '', attachments: [] as Attachment[] }
      draftRef.current = cleared; setDraft(cleared)
      editor?.commands.clearContent(false)
      await persist.current(session.id, { draft: cleared }).catch(() => {})
    } catch (e) { onError((e as Error).message) } finally { setSending(false); editor?.commands.focus() }
  }
  const applyLaunch = async () => {
    setApplying(true)
    try {
      const base = session.launch ?? { model: '', reasoningEffort: '' as const, approvalMode: 'on-request' as const, permissionProfile: '', trustWorkspace: false, yolo: false }
      await patch(session.id, { launch: { ...base, model: model.trim().slice(0, 200), reasoningEffort: effort } }); setSettings(false)
    }
    catch (e) { onError((e as Error).message) } finally { setApplying(false) }
  }
  const restart = async () => {
    setRestarting(true)
    try {
      await flushTerminalDraft(session.id)
      await bridge.invoke('terminalClose', { id: session.id })
      await bridge.invoke('terminalOpen', { id: session.id })
    } catch (e) { onError((e as Error).message) } finally { setRestarting(false) }
  }
  const isShell = session.terminalKind === 'shell'
  const launchSummary = formatComposerSummary(session)
  return <footer ref={composer} className="composer terminal-composer">
    {matches.length > 0 && <div className="skill-menu" role="listbox" aria-label="Skills">{matches.map((skill, i) => <button role="option" aria-selected={i === activeSkill} key={skill.id} className={i === activeSkill ? 'active' : ''} onMouseDown={e => { e.preventDefault(); choose(skill) }}><span><strong>/{skill.name}</strong><small>{skill.description}</small></span></button>)}</div>}
    {draft.attachments.length > 0 && <div className="attachment-list">{draft.attachments.map(a => <div className="attachment" key={a.id}>{a.preview ? <img src={a.preview} alt={a.name} /> : <File size={22} />}<span title={a.name}>{a.name}</span><button aria-label={`Remove ${a.name}`} onClick={() => saveDraft({ ...draftRef.current, attachments: draftRef.current.attachments.filter(x => x.id !== a.id) })}><X size={12} /></button></div>)}</div>}
    <EditorContent editor={editor} />
    <div className="composer-tools">
      <input ref={fileInput} type="file" multiple hidden onChange={e => { addFilesRef.current(Array.from(e.target.files ?? [])); e.target.value = '' }} />
      <button className="icon-button" aria-label="Attach files" title="Attach files or images" disabled={uploading || sending} onClick={() => fileInput.current?.click()}>{uploading ? <Loader2 size={17} className="spin" /> : <Paperclip size={17} />}</button>
      {!isShell && <button className="model-trigger" onClick={() => setSettings(!settings)} aria-expanded={settings} title={launchSummary}><span>{launchSummary}</span><ChevronDown size={12} /></button>}
      <span className="enter-hint">↵ sends · ⇧↵ newline</span>
      <button className="send-button" aria-label="Send prompt to terminal" disabled={sending || uploading || !session.terminalRunning || (!draft.text.trim() && !draft.attachments.length)} onClick={() => submitRef.current()}>{sending ? <Loader2 size={16} className="spin" /> : <ArrowUp size={19} />}</button>
    </div>
    {!isShell && settings && <div className="model-settings">
      <label>Model<input value={model} list={`models-${session.id}`} placeholder="Muse default" disabled={session.terminalRunning} onChange={e => setModel(e.target.value)} /></label>
      <datalist id={`models-${session.id}`}>{models.map(m => <option value={m.modelId} key={m.modelId}>{m.displayLabel}</option>)}</datalist>
      <label>Reasoning effort<select value={effort} disabled={session.terminalRunning} onChange={e => setEffort(e.target.value as typeof effort)}>{EFFORTS.map(v => <option value={v} key={v}>{v || 'Default'}</option>)}</select></label>
      <div className="model-actions">
        <button className="small-button" disabled={applying || session.terminalRunning} onClick={() => void applyLaunch()}>{applying ? 'Applying…' : 'Apply (next open)'}</button>
        <button className="small-button" disabled={restarting} title="Reopen the terminal to apply new flags" onClick={() => void restart()}><RotateCcw size={13} />{restarting ? 'Restarting…' : 'Restart terminal'}</button>
      </div>
      {session.terminalRunning && <p className="modal-warning">Close or restart the terminal to change model and effort. They are launch flags for `muse`.</p>}
    </div>}
  </footer>
}
