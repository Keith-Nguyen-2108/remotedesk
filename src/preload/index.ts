import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ClipSnapshot } from '../shared/clipboard-sync'
import type { SignalMessage } from '../shared/protocol'

function on(channel: string, cb: (payload: unknown) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  identity: {
    get: () => ipcRenderer.invoke('identity:get'),
    regenerate: () => ipcRenderer.invoke('identity:regenerate'),
    copy: () => ipcRenderer.invoke('identity:copy')
  },
  screens: {
    list: () => ipcRenderer.invoke('screens:list'),
    select: (id: string) => ipcRenderer.invoke('screens:select', id)
  },
  session: {
    connect: (token: string) => ipcRenderer.invoke('session:connect', token),
    disconnect: () => ipcRenderer.invoke('session:disconnect')
  },
  /** Internet mode: an optional public relay that lets two machines connect
   * even when LAN discovery finds nothing. */
  relay: {
    get: () => ipcRenderer.invoke('relay:get'),
    set: (url: string | null) => ipcRenderer.invoke('relay:set', url),
    onStatus: (cb: (p: unknown) => void) => on('relay:status', cb)
  },
  /** Incoming role: someone is connecting to this machine. */
  host: {
    signal: (msg: SignalMessage) => ipcRenderer.invoke('host:signal', msg),
    abortSession: (reason: string) => ipcRenderer.invoke('host:abort-session', reason),
    onClientJoined: (cb: (p: unknown) => void) => on('host:client-joined', cb),
    onClientLeft: (cb: (p: unknown) => void) => on('host:client-left', cb),
    onSignal: (cb: (p: unknown) => void) => on('host:signal', cb)
  },
  /** Outgoing role: this machine is viewing someone else. */
  client: {
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
    save: (name: string, data: Uint8Array) => ipcRenderer.invoke('file:save', { name, data }),
    reveal: (path: string) => ipcRenderer.invoke('file:reveal', path),
    previewImage: (dataUrl: string) => ipcRenderer.invoke('file:preview-image', dataUrl)
  },
  clipboard: {
    watch: (value: boolean) => ipcRenderer.invoke('clipboard:watch', value),
    applyRemote: (snapshot: ClipSnapshot) => ipcRenderer.invoke('clipboard:apply-remote', snapshot),
    onLocalChange: (cb: (p: unknown) => void) => on('clipboard:local', cb)
  },
  /** Self-update against the release the pipeline publishes. */
  update: {
    currentVersion: () => ipcRenderer.invoke('update:current-version'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install')
  },
  permissions: {
    get: () => ipcRenderer.invoke('permissions:get'),
    openScreen: () => ipcRenderer.invoke('permissions:open-screen'),
    openAccessibility: () => ipcRenderer.invoke('permissions:open-accessibility'),
    promptAccessibility: () => ipcRenderer.invoke('permissions:prompt-accessibility')
  }
}

contextBridge.exposeInMainWorld('rd', api)

export type RdApi = typeof api
