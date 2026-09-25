import { app, BrowserWindow, Menu, Notification, ipcMain, dialog, shell, clipboard } from 'electron'
import { join, basename } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { HubService } from '../server/service'
import { SupervisorClient, supervisorSocketPath } from '../server/supervisor-client'
import { Terminals, type TerminalHost } from '../server/terminals'
import { spawn } from 'node:child_process'
import type { AgentActivity, TerminalResource } from '../src/types'
import type { BoardNote } from '../shared/board'

let service: HubService
let window: BrowserWindow | undefined
const development = !app.isPackaged
const root = process.env.AGENT_HUB_PROJECT_ROOT || (app.isPackaged ? homedir() : process.cwd())
if (development) app.setPath('userData', join(root, '.agent-hub', 'electron'))
app.setName('Agent Hub')
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { window?.show(); window?.focus() })
  app.whenReady().then(async () => {
    const dataDir = process.env.AGENT_HUB_DATA_DIR || (development ? join(root, '.agent-hub') : join(app.getPath('userData'), 'workspace'))
    // Agent terminals live in a supervisor process so they keep running
    // after the app quits; the app reattaches on launch. Without the
    // supervisor, terminals run in this process as before.
    let terminals: TerminalHost
    try {
      mkdirSync(dataDir, { recursive: true })
      const socketPath = supervisorSocketPath(dataDir)
      terminals = await SupervisorClient.connect(socketPath, () => {
        spawn(process.execPath, [join(__dirname, 'supervisor.cjs'), socketPath], { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).unref()
      })
    } catch { terminals = new Terminals() }
    // An explicit application menu keeps macOS menu validation on Electron-owned
    // items. Without it, the default menu repeatedly logs
    // "representedObject is not a WeakPtrToElectronMenuModelAsNSObject".
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.name, submenu: [
        { role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        { label: 'Quit and Stop Agents', accelerator: 'Alt+Command+Q', click: async () => { await (terminals as { shutdown?: () => Promise<void> }).shutdown?.(); app.quit() } },
        { role: 'quit', label: 'Quit (Agents Keep Running)' },
      ] },
      { role: 'editMenu' }, { role: 'windowMenu' },
    ]))
    service = new HubService(dataDir, root, join(__dirname, 'board-cli.cjs'), terminals)
    service.adoptRunning()
    const create = () => {
      window = new BrowserWindow({ width: 1512, height: 980, minWidth: 860, minHeight: 600, title: 'Agent Hub', backgroundColor: '#17191c', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 19 }, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
      window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' } })
      window.webContents.on('will-navigate', (event, url) => { if (url !== window?.webContents.getURL()) event.preventDefault() })
      if (process.env.AGENT_HUB_DEV_URL) void window.loadURL(process.env.AGENT_HUB_DEV_URL)
      else void window.loadFile(join(__dirname, '../dist/index.html'))
      window.on('closed', () => { window = undefined })
    }
    const invoke = async (event: Electron.IpcMainInvokeEvent, action: string, args = {}) => {
      if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Invalid sender')
      if (action === 'chooseRepo') {
        const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: 'Add a repository' })
        return result.canceled ? null : result.filePaths[0]
      }
      if (action === 'clipboard') {
        const file = clipboard.read('public.file-url')
        if (file.startsWith('file://')) {
          const path = fileURLToPath(file)
          return [service.saveAttachment({ name: basename(path), base64: readFileSync(path).toString('base64'), mime: /\.png$/i.test(path) ? 'image/png' : /\.jpe?g$/i.test(path) ? 'image/jpeg' : 'application/octet-stream' })]
        }
        const image = clipboard.readImage()
        return image.isEmpty() ? [] : [service.saveAttachment({ name: `Screenshot-${Date.now()}.png`, mime: 'image/png', base64: image.toPNG().toString('base64') })]
      }
      return service.invoke(action, args)
    }
    ipcMain.handle('agent-hub:invoke', async (event, action, args) => {
      try {
        const value = await invoke(event, action, args)
        return { ok: true, value }
      }
      catch (error) {
        return { ok: false, error: (error as Error).message }
      }
    })
    const valid = (event: Electron.IpcMainEvent) => event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame
    ipcMain.on('agent-hub:terminal-input',(event,id,data)=>{if(valid(event))service.terminals.write(id,data)})
    ipcMain.on('agent-hub:terminal-resize',(event,id,cols,rows)=>{if(valid(event))service.terminals.resize(id,cols,rows)})
    service.on('terminal', event => window?.webContents.send('agent-hub:terminal', event))
    service.on('resource', resource => window?.webContents.send('agent-hub:resource', resource))
    service.on('tickets', snapshot => window?.webContents.send('agent-hub:tickets', snapshot))
    service.on('board', snapshot => window?.webContents.send('agent-hub:board', snapshot))
    service.on('workspace', state => window?.webContents.send('agent-hub:workspace', state))
    // Agents that need the person raise a notification and count toward the
    // Dock badge; a finished turn notifies only when the window is unfocused.
    const waiting = new Set<string>()
    const notices = new Set<Notification>()
    const questions = new Map<string, number>()
    const badge = () => app.setBadgeCount(waiting.size + [...questions.values()].reduce((sum, count) => sum + count, 0))
    const bringForward = () => { if (!window) create(); window?.show(); window?.focus() }
    const focusTerminal = (id: string) => { bringForward(); window?.webContents.send('agent-hub:focus-terminal', id) }
    const notify = (options: Electron.NotificationConstructorOptions, onClick: () => void) => {
      if (!Notification.isSupported()) return
      const notice = new Notification(options)
      // Hold a reference until the notification is dismissed so its click handler survives GC.
      notices.add(notice)
      notice.on('click', () => { notices.delete(notice); onClick() })
      notice.on('close', () => notices.delete(notice))
      notice.show()
    }
    service.on('questions', ({ repo, count }: { repo: string; count: number }) => { questions.set(repo, count); badge() })
    service.on('question', ({ repo, note }: { repo: string; note: BoardNote }) => {
      notify({ title: `${note.question?.askedBy ?? 'An agent'} asks about “${note.title}”`, body: note.question?.text ?? '' }, () => { bringForward(); window?.webContents.send('agent-hub:focus-note', { repo, id: note.id }) })
    })
    service.on('activity', ({ resource, previous }: { resource: TerminalResource; previous?: AgentActivity }) => {
      const activity = resource.activity
      if (!activity) return
      if (activity.state === 'waiting') waiting.add(resource.id); else waiting.delete(resource.id)
      badge()
      const needsYou = activity.state === 'waiting' && previous?.state !== 'waiting'
      const finished = activity.state === 'idle' && previous?.state === 'working' && !window?.isFocused()
      if (needsYou || finished) notify({ title: needsYou ? `${resource.name} needs you` : `${resource.name} finished`, body: activity.detail, silent: finished }, () => focusTerminal(resource.id))
    })
    create()
    app.on('activate', () => { if (!window) create() })
  }).catch(error => { dialog.showErrorBox('Agent Hub could not open', String(error)); app.quit() })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => service?.close())
}
