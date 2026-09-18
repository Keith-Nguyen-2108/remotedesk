import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { hostname, platform } from 'node:os'
import { basename, join } from 'node:path'
import type { ClipSnapshot } from '../shared/clipboard-sync'
import { formatToken, normalizeToken } from '../shared/identity'
import { DEFAULT_SIGNAL_PORT, type SignalMessage } from '../shared/protocol'
import { imageDataUrlSubtype } from '../shared/shares'
import { getSelectedScreen, listScreens, setSelectedScreen } from './capture'
import { ClipboardWatcher } from './clipboard'
import { DiscoveryResponder, findHostByToken } from './discovery'
import { getToken, regenerateToken } from './identity'
import { applyInputRaw, isInputEnabled, setInputEnabled } from './input'
import {
  getPermissionState,
  openAccessibilitySettings,
  openScreenRecordingSettings,
  promptAccessibility
} from './permissions'
import { SignalingClient } from './signaling-client'
import { SignalingServer } from './signaling-server'

let server: SignalingServer | null = null
let responder: DiscoveryResponder | null = null
let outgoing: SignalingClient | null = null

function emit(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

const clipboardWatcher = new ClipboardWatcher((snapshot) => emit('clipboard:local', snapshot))

/**
 * A correct ID proves the caller knows your secret; it does not prove you want
 * them on your desktop right now. Ask, with the window brought forward.
 */
async function askToApprove(clientName: string): Promise<boolean> {
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

/**
 * Every machine listens from launch, so a partner who has your ID can reach you
 * without you doing anything first. Nothing is captured until you approve.
 */
export async function startListening(): Promise<number> {
  await stopListening()

  const s = new SignalingServer({
    port: DEFAULT_SIGNAL_PORT,
    secret: getToken,
    hostName: hostname(),
    approveClient: askToApprove,
    onClientAuthenticated: (clientName) => emit('host:client-joined', { clientName }),
    onMessage: (msg) => emit('host:signal', msg),
    onClientGone: () => {
      void setInputEnabled(false)
      clipboardWatcher.stop()
      emit('host:client-left', {})
    }
  })
  const port = await s.start()

  const r = new DiscoveryResponder({
    token: getToken,
    beacon: () => ({ hostName: hostname(), port, platform: platform() })
  })
  await r.start()

  server = s
  responder = r
  return port
}

export async function stopListening(): Promise<void> {
  await setInputEnabled(false)
  clipboardWatcher.stop()
  await server?.stop()
  await responder?.stop()
  server = null
  responder = null
}

export function registerIpc(): void {
  // ---- identity ----
  ipcMain.handle('identity:get', () => {
    const token = getToken()
    return {
      token,
      formatted: formatToken(token),
      machineName: hostname(),
      platform: platform()
    }
  })

  ipcMain.handle('identity:regenerate', () => {
    const token = regenerateToken()
    return { token, formatted: formatToken(token) }
  })

  ipcMain.handle('identity:copy', () => {
    clipboard.writeText(formatToken(getToken()))
    return { copied: true as const }
  })

  // ---- screens ----
  ipcMain.handle('screens:list', () => listScreens())
  ipcMain.handle('screens:select', (_e, id: string) => {
    setSelectedScreen(id)
    return getSelectedScreen()
  })

  // ---- connecting out, by the partner's ID ----
  ipcMain.handle('session:connect', async (_e, rawToken: string) => {
    const token = normalizeToken(rawToken)
    if (!token) throw new Error('that ID is not 12 digits')
    if (token === getToken()) throw new Error('that is this machine\'s own ID')

    const found = await findHostByToken(token)
    if (!found) {
      throw new Error('no machine with that ID answered on this network')
    }

    await outgoing?.close()
    const c = new SignalingClient({
      host: found.address,
      port: found.port,
      secret: token,
      clientName: hostname(),
      onConnected: (hostName) => emit('client:connected', { hostName, address: found.address }),
      onMessage: (msg) => emit('client:signal', msg),
      onClosed: (code, reason) => emit('client:closed', { code, reason })
    })
    await c.connect()
    outgoing = c
    return { hostName: found.hostName, address: found.address }
  })

  ipcMain.handle('session:disconnect', async () => {
    await outgoing?.close()
    outgoing = null
    clipboardWatcher.stop()
  })

  ipcMain.handle('host:signal', (_e, msg: SignalMessage) => server?.send(msg))
  ipcMain.handle('client:signal', (_e, msg: SignalMessage) => outgoing?.send(msg))

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

  // ---- shares panel: reveal a saved file, or preview an image with the OS's own viewer ----
  ipcMain.handle('file:reveal', (_e, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle('file:preview-image', async (_e, dataUrl: string) => {
    const subtype = imageDataUrlSubtype(dataUrl)
    if (!subtype) return { opened: false as const, reason: 'not an image' }

    const ext = subtype === 'jpeg' ? 'jpg' : subtype.replace(/[^a-z0-9]/g, '') || 'png'
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    const dir = join(app.getPath('temp'), 'remotedesk-previews')
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, `share-${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`)
    await writeFile(filePath, Buffer.from(base64, 'base64'))

    // openPath hands the file to whatever the OS already uses for that type
    // (Preview on macOS, Photos on Windows) - no bespoke viewer to maintain.
    const error = await shell.openPath(filePath)
    return error ? { opened: false as const, reason: error } : { opened: true as const, path: filePath }
  })
}
