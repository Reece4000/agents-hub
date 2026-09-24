import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('agentHub', {
  desktop: true,
  invoke: async (action: string, args?: unknown) => {
    const reply = await ipcRenderer.invoke('agent-hub:invoke', action, args)
    if (!reply.ok) throw new Error(reply.error)
    return reply.value
  },
  onResource: (listener: (value: unknown) => void) => { const h = (_event: unknown, value: unknown) => listener(value); ipcRenderer.on('agent-hub:resource', h); return () => ipcRenderer.removeListener('agent-hub:resource', h) },
  onTickets: (listener: (value: unknown) => void) => { const h = (_event: unknown, value: unknown) => listener(value); ipcRenderer.on('agent-hub:tickets', h); return () => ipcRenderer.removeListener('agent-hub:tickets', h) },
  onBoard: (listener: (value: unknown) => void) => { const h = (_event: unknown, value: unknown) => listener(value); ipcRenderer.on('agent-hub:board', h); return () => ipcRenderer.removeListener('agent-hub:board', h) },
  onTerminal: (listener: (value: unknown) => void) => { const h = (_event: unknown, value: unknown) => listener(value); ipcRenderer.on('agent-hub:terminal', h); return () => ipcRenderer.removeListener('agent-hub:terminal', h) },
  terminalInput: (id:string,data:string) => ipcRenderer.send('agent-hub:terminal-input',id,data),
  terminalResize: (id:string,cols:number,rows:number) => ipcRenderer.send('agent-hub:terminal-resize',id,cols,rows),
  subscribe: (listener: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => listener(state)
    ipcRenderer.on('agent-hub:workspace', handler)
    return () => ipcRenderer.removeListener('agent-hub:workspace', handler)
  }
})
