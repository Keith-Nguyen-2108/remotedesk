import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ClipSnapshot } from '../shared/clipboard-sync'
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
  input: {
    apply: (raw: string) => ipcRenderer.invoke('input:apply', raw),
    setEnabled: (value: boolean) => ipcRenderer.invoke('input:set-enabled', value),
    isEnabled: () => ipcRenderer.invoke('input:is-enabled')
  },
  files: {
    save: (name: string, data: Uint8Array) => ipcRenderer.invoke('file:save', { name, data })
  },
  clipboard: {
    watch: (value: boolean) => ipcRenderer.invoke('clipboard:watch', value),
    applyRemote: (snapshot: ClipSnapshot) => ipcRenderer.invoke('clipboard:apply-remote', snapshot),
    onLocalChange: (cb: (p: unknown) => void) => on('clipboard:local', cb)
  },
  permissions: {
    get: () => ipcRenderer.invoke('permissions:get'),
    openScreen: () => ipcRenderer.invoke('permissions:open-screen'),
    openAccessibility: () => ipcRenderer.invoke('permissions:open-accessibility'),
    promptAccessibility: () => ipcRenderer.invoke('permissions:prompt-accessibility')
  },
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url)
}

contextBridge.exposeInMainWorld('rd', api)

export type RdApi = typeof api
