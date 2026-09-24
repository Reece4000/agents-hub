import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Paperclip, X, File, Loader2, Mic, Square } from 'lucide-react'
import { bridge } from './bridge'
import { buildTerminalPrompt, bracketedPaste } from './terminalPrompt'
import type { TerminalResource, Attachment, Draft } from './types'

const drafts = new Map<string, () => Promise<unknown>>()
export const flushTerminalDraft = (id: string) => drafts.get(id)?.() ?? Promise.resolve()
const draftGetters = new Map<string, () => import('./types').Draft>()
export const getTerminalDraft = (id: string) => draftGetters.get(id)?.()

/** Rich prompt docked below an agent terminal. It keeps a multiline draft
 *  with attachments and sends it to the agent as one bracketed paste. */
export default function TerminalComposer({ session, onError, patch }: {
  session: TerminalResource;
  onError: (error: string) => void; patch: (id: string, changes: Partial<TerminalResource>) => Promise<unknown>
}) {
  const [draft, setDraft] = useState<Draft>(session.draft)
  const draftRef = useRef(draft)
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [dictation, setDictation] = useState<'idle' | 'starting' | 'recording' | 'processing'>('idle')
  const fileInput = useRef<HTMLInputElement>(null)
  const composer = useRef<HTMLElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const submitRef = useRef<() => void>(() => {})
  const addFilesRef = useRef<(files: File[]) => void>(() => {})
  const clipboardRef = useRef<() => void>(() => {})
  const persist = useRef(patch)
  persist.current = patch
  const saveDraft = (next: Draft) => {
    draftRef.current = next; setDraft(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void persist.current(session.id, { draft: draftRef.current }).catch(e => onError(e.message)), 150)
  }
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false, codeBlock: false, link: { openOnClick: false } }), Placeholder.configure({ placeholder: `Message ${session.agent}…  Enter sends · Shift+Enter newline` })],
    content: session.draft.html || '',
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': 'Terminal prompt', 'aria-multiline': 'true', spellcheck: 'true' },
      handleKeyDown: (_view, event) => {
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
  // Speak a prompt: the on-device transcript is added to the draft to
  // review before sending.
  const toggleDictation = async () => {
    if (dictation === 'recording') {
      setDictation('processing')
      try {
        const text = (await bridge.invoke<string>('dictation:stop')).trim()
        if (text) editor?.chain().focus('end').insertContent(`${editor.isEmpty ? '' : ' '}${text}`).run()
        else onError('No speech was detected.')
      } catch (e) { onError((e as Error).message) } finally { setDictation('idle') }
      return
    }
    if (dictation !== 'idle') return
    setDictation('starting')
    try { await bridge.invoke('dictation:start'); setDictation('recording') }
    catch (e) { setDictation('idle'); onError((e as Error).message) }
  }
  const recording = useRef(false)
  recording.current = dictation === 'recording' || dictation === 'starting'
  useEffect(() => () => { if (recording.current) void bridge.invoke('dictation:cancel').catch(() => {}) }, [])
  submitRef.current = async () => {
    if (sending || uploading) return
    if (!bridge.terminalInput) { onError('Rich prompts need the desktop app.'); return }
    if (!session.terminalRunning) { onError('Open the terminal first, then send the prompt.'); return }
    const current = draftRef.current
    if (!current.text.trim() && !current.attachments.length) return
    clearTimeout(timer.current); setSending(true)
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
  return <footer ref={composer} className="composer terminal-composer">
    {draft.attachments.length > 0 && <div className="attachment-list">{draft.attachments.map(a => <div className="attachment" key={a.id}>{a.preview ? <img src={a.preview} alt={a.name} /> : <File size={22} />}<span title={a.name}>{a.name}</span><button aria-label={`Remove ${a.name}`} onClick={() => saveDraft({ ...draftRef.current, attachments: draftRef.current.attachments.filter(x => x.id !== a.id) })}><X size={12} /></button></div>)}</div>}
    <EditorContent editor={editor} />
    <div className="composer-tools">
      <input ref={fileInput} type="file" multiple hidden onChange={e => { addFilesRef.current(Array.from(e.target.files ?? [])); e.target.value = '' }} />
      <button className="icon-button" aria-label="Attach files" title="Attach files or images" disabled={uploading || sending} onClick={() => fileInput.current?.click()}>{uploading ? <Loader2 size={17} className="spin" /> : <Paperclip size={17} />}</button>
      {bridge.desktop && <button className={`icon-button dictate-button${dictation === 'recording' ? ' recording' : ''}`} aria-label={dictation === 'recording' ? 'Stop dictating' : 'Dictate a prompt'} title={dictation === 'recording' ? 'Stop and insert the transcript' : 'Dictate a prompt'} disabled={dictation === 'starting' || dictation === 'processing' || sending} onClick={() => void toggleDictation()}>{dictation === 'recording' ? <Square size={14} /> : dictation === 'idle' ? <Mic size={16} /> : <Loader2 size={16} className="spin" />}</button>}
      <span className="enter-hint">{dictation === 'recording' ? 'Listening… click ■ to insert' : '↵ sends · ⇧↵ newline'}</span>
      <button className="send-button" aria-label="Send prompt to terminal" disabled={sending || uploading || !session.terminalRunning || (!draft.text.trim() && !draft.attachments.length)} onClick={() => submitRef.current()}>{sending ? <Loader2 size={16} className="spin" /> : <ArrowUp size={19} />}</button>
    </div>
  </footer>
}
