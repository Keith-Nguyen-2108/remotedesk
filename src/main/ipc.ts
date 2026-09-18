import { BrowserWindow, ipcMain, shell } from 'electron'
import { hostname, platform } from 'node:os'
import { generatePin } from '../shared/auth'
import { DEFAULT_SIGNAL_PORT, type SignalMessage } from '../shared/protocol'
import { getSelectedScreen, listScreens, setSelectedScreen } from './capture'
import { DiscoveryResponder, queryHosts, type DiscoveredHost } from './discovery'
import { SignalingServer } from './signaling-server'
import { SignalingClient } from './signaling-client'

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
    await stopHost()
    host.pin = generatePin()
    const server = new SignalingServer({
      port: DEFAULT_SIGNAL_PORT,
      pin: host.pin,
      hostName: hostname(),
      onClientAuthenticated: (clientName) => emit('host:client-joined', { clientName }),
      onMessage: (msg) => emit('host:signal', msg),
      onClientGone: () => emit('host:client-left', {})
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
  })

  ipcMain.handle('client:signal', (_e, msg: SignalMessage) => {
    client?.send(msg)
  })

  ipcMain.handle('shell:open-external', (_e, url: string) => shell.openExternal(url))
}

async function stopHost(): Promise<void> {
  await host.server?.stop()
  await host.responder?.stop()
  host.server = null
  host.responder = null
}
