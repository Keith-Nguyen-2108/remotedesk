import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { SignalMessage } from '../shared/protocol'

function on(channel: string, cb: (payload: unknown) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  identity: () => ipcRenderer.invoke('app:identity'),
  screens: {
    list: () => ipcRenderer.invoke('screens:list'),
    select: (id: string) => ipcRenderer.invoke('screens:select', id)
  },
  host: {
    start: () => ipcRenderer.invoke('host:start'),
    stop: () => ipcRenderer.invoke('host:stop'),
    signal: (msg: SignalMessage) => ipcRenderer.invoke('host:signal', msg),
    onClientJoined: (cb: (p: unknown) => void) => on('host:client-joined', cb),
    onClientLeft: (cb: (p: unknown) => void) => on('host:client-left', cb),
    onSignal: (cb: (p: unknown) => void) => on('host:signal', cb)
  },
  client: {
    discover: () => ipcRenderer.invoke('client:discover'),
    connect: (args: { address: string; port: number; pin: string }) =>
      ipcRenderer.invoke('client:connect', args),
    disconnect: () => ipcRenderer.invoke('client:disconnect'),
    signal: (msg: SignalMessage) => ipcRenderer.invoke('client:signal', msg),
    onConnected: (cb: (p: unknown) => void) => on('client:connected', cb),
    onClosed: (cb: (p: unknown) => void) => on('client:closed', cb),
    onSignal: (cb: (p: unknown) => void) => on('client:signal', cb)
  },
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url)
}

contextBridge.exposeInMainWorld('rd', api)

export type RdApi = typeof api
