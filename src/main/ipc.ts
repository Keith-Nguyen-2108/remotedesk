import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { hostname, platform } from 'node:os'
import { basename, join } from 'node:path'
import { generatePin } from '../shared/auth'
import type { ClipSnapshot } from '../shared/clipboard-sync'
import { DEFAULT_SIGNAL_PORT, type SignalMessage } from '../shared/protocol'
import { normalizeExternalUrl } from '../shared/url-guard'
import { getSelectedScreen, listScreens, setSelectedScreen } from './capture'
import { ClipboardWatcher } from './clipboard'
import { DiscoveryResponder, queryHosts, type DiscoveredHost } from './discovery'
import { applyInputRaw, isInputEnabled, setInputEnabled } from './input'
import {
  getPermissionState,
  openAccessibilitySettings,
  openScreenRecordingSettings,
  promptAccessibility
} from './permissions'
import { SignalingClient } from './signaling-client'
import { SignalingServer } from './signaling-server'

interface HostState {
  pin: string
  server: SignalingServer | null
  responder: DiscoveryResponder | null
}

const host: HostState = { pin: generatePin(), server: null, responder: null }
let client: SignalingClient | null = null

function emit(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

const clipboardWatcher = new ClipboardWatcher((snapshot) => emit('clipboard:local', snapshot))

/**
 * A correct PIN proves the caller knows the secret; it does not prove you want
 * them on your desktop right now. Ask, with the window brought forward.
 */
async function askHostToApprove(clientName: string): Promise<boolean> {
  const [win] = BrowserWindow.getAllWindows()
  if (!win) return false
  win.show()
  win.focus()
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Allow', 'Deny'],
    defaultId: 1,
    cancelId: 1,
    message: `Allow "${clientName}" to view and control this machine?`,
    detail:
      'They will see your screen and, unless you turn it off, control your mouse and keyboard.'
  })
  return response === 0
}

export function registerIpc(): void {
  ipcMain.handle('app:identity', () => ({
    machineName: hostname(),
    platform: platform()
  }))

  ipcMain.handle('screens:list', () => listScreens())
  ipcMain.handle('screens:select', (_e, id: string) => {
    setSelectedScreen(id)
    return getSelectedScreen()
  })

  // ---- host role ----
  ipcMain.handle('host:start', async () => {
    const permissions = getPermissionState()
    if (!permissions.ready) {
      throw new Error(
        'grant Screen Recording and Accessibility to RemoteDesk, then relaunch the app'
      )
    }

    await stopHost()
    host.pin = generatePin()
    const server = new SignalingServer({
      port: DEFAULT_SIGNAL_PORT,
      pin: host.pin,
      hostName: hostname(),
      approveClient: askHostToApprove,
      onClientAuthenticated: (clientName) => emit('host:client-joined', { clientName }),
      onMessage: (msg) => emit('host:signal', msg),
      onClientGone: () => {
        void setInputEnabled(false)
        clipboardWatcher.stop()
        emit('host:client-left', {})
      }
    })
    const port = await server.start()
    const responder = new DiscoveryResponder({
      beacon: () => ({ hostName: hostname(), port, platform: platform() })
    })
    await responder.start()
    host.server = server
    host.responder = responder
    return { pin: host.pin, port }
  })

  ipcMain.handle('host:stop', () => stopHost())
  ipcMain.handle('host:signal', (_e, msg: SignalMessage) => {
    host.server?.send(msg)
  })

  // ---- client role ----
  ipcMain.handle('client:discover', (): Promise<DiscoveredHost[]> => queryHosts())

  ipcMain.handle(
    'client:connect',
    async (_e, args: { address: string; port: number; pin: string }) => {
      await client?.close()
      const c = new SignalingClient({
        host: args.address,
        port: args.port,
        pin: args.pin,
        clientName: hostname(),
        onConnected: (hostName) => emit('client:connected', { hostName }),
        onMessage: (msg) => emit('client:signal', msg),
        onClosed: (code, reason) => emit('client:closed', { code, reason })
      })
      await c.connect()
      client = c
      return { ok: true as const }
    }
  )

  ipcMain.handle('client:disconnect', async () => {
    await client?.close()
    client = null
    clipboardWatcher.stop()
  })

  ipcMain.handle('client:signal', (_e, msg: SignalMessage) => {
    client?.send(msg)
  })

  // ---- input injection ----
  ipcMain.handle('input:apply', (_e, raw: string) => applyInputRaw(raw))
  ipcMain.handle('input:set-enabled', (_e, value: boolean) => setInputEnabled(value))
  ipcMain.handle('input:is-enabled', () => isInputEnabled())

  // ---- file transfer ----
  ipcMain.handle('file:save', async (_e, args: { name: string; data: Uint8Array }) => {
    // basename() stops a hostile peer from proposing "../../.ssh/authorized_keys".
    const safeName = basename(args.name) || 'received-file'
    const result = await dialog.showSaveDialog({
      title: 'Save received file',
      defaultPath: join(app.getPath('downloads'), safeName)
    })
    if (result.canceled || !result.filePath) return { saved: false as const }
    await writeFile(result.filePath, Buffer.from(args.data))
    return { saved: true as const, path: result.filePath }
  })

  // ---- clipboard ----
  ipcMain.handle('clipboard:watch', (_e, value: boolean) => {
    if (value) clipboardWatcher.start()
    else clipboardWatcher.stop()
  })
  ipcMain.handle('clipboard:apply-remote', (_e, snapshot: ClipSnapshot) => {
    clipboardWatcher.applyRemote(snapshot)
  })

  // ---- permissions ----
  ipcMain.handle('permissions:get', () => getPermissionState())
  ipcMain.handle('permissions:open-screen', () => openScreenRecordingSettings())
  ipcMain.handle('permissions:open-accessibility', () => openAccessibilitySettings())
  ipcMain.handle('permissions:prompt-accessibility', () => promptAccessibility())

  // ---- links ----
  ipcMain.handle('shell:open-external', async (_e, url: string) => {
    const safe = normalizeExternalUrl(url)
    if (!safe) return { opened: false as const, reason: 'unsafe or malformed url' }

    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Open', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: 'Open this link sent from the other machine?',
        detail: safe
      })
      if (response !== 0) return { opened: false as const, reason: 'declined' }
    }

    await shell.openExternal(safe)
    return { opened: true as const, url: safe }
  })
}

async function stopHost(): Promise<void> {
  await setInputEnabled(false)
  clipboardWatcher.stop()
  await host.server?.stop()
  await host.responder?.stop()
  host.server = null
  host.responder = null
}
