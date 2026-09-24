import { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard } from 'electron'
import { join, basename } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { MuseService } from '../server/service'

let service: MuseService
let window: BrowserWindow | undefined
const development = !app.isPackaged
const root = process.env.AGENT_HUB_PROJECT_ROOT || (app.isPackaged ? homedir() : process.cwd())
if (development) app.setPath('userData', join(root, '.agent-hub', 'electron'))
app.setName('Agent Hub')
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { window?.show(); window?.focus() })
  app.whenReady().then(() => {
    // An explicit application menu keeps macOS menu validation on Electron-owned
    // items. Without it, the default menu repeatedly logs
    // "representedObject is not a WeakPtrToElectronMenuModelAsNSObject".
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]))
    service = new MuseService(process.env.AGENT_HUB_DATA_DIR || (development ? join(root, '.agent-hub') : join(app.getPath('userData'), 'workspace')), root, undefined, join(__dirname, 'board-cli.cjs'))
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
    create()
    app.on('activate', () => { if (!window) create() })
  }).catch(error => { dialog.showErrorBox('Agent Hub could not open', String(error)); app.quit() })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => service?.close())
}
