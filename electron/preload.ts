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
  onFocusTerminal: (listener: (id: string) => void) => { const h = (_event: unknown, id: string) => listener(id); ipcRenderer.on('agent-hub:focus-terminal', h); return () => ipcRenderer.removeListener('agent-hub:focus-terminal', h) },
  onFocusNote: (listener: (target: { repo: string; id: string }) => void) => { const h = (_event: unknown, target: { repo: string; id: string }) => listener(target); ipcRenderer.on('agent-hub:focus-note', h); return () => ipcRenderer.removeListener('agent-hub:focus-note', h) },
  terminalInput: (id:string,data:string) => ipcRenderer.send('agent-hub:terminal-input',id,data),
  terminalResize: (id:string,cols:number,rows:number) => ipcRenderer.send('agent-hub:terminal-resize',id,cols,rows),
  subscribe: (listener: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => listener(state)
    ipcRenderer.on('agent-hub:workspace', handler)
    return () => ipcRenderer.removeListener('agent-hub:workspace', handler)
  }
})
