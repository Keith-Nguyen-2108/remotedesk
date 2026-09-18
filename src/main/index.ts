import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { registerDisplayMediaHandler } from './capture'
import { registerIpc, startListening, stopListening } from './ipc'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'RemoteDesk',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Never let the app itself be navigated away or spawn arbitrary windows.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env.ELECTRON_RENDERER_URL
    const isDevServer = devServer !== undefined && url.startsWith(devServer)
    if (!isDevServer && !url.startsWith('file://')) event.preventDefault()
  })

  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  registerDisplayMediaHandler()
  registerIpc()
  createWindow()

  // Listen from launch so a partner holding this machine's ID can reach it.
  try {
    await startListening()
  } catch (err) {
    console.error('failed to start listening:', (err as Error).message)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => void stopListening())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
