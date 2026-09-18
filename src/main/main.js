const {
  app, BrowserWindow, ipcMain, desktopCapturer, session,
  clipboard, shell, screen, nativeImage
} = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { WebSocketServer, WebSocket } = require('ws');

const SIGNAL_PORT = 9512;

let win = null;
let wss = null;        // host: signaling server
let hostPeer = null;   // host: the one authed client socket
let clientWs = null;   // client: connection to host
let currentPin = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    title: 'RemoteDesk',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Auto-approve the app's own getDisplayMedia() with the primary screen.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: false });
    }).catch(() => callback({}));
  }, { useSystemPicker: false });
}

function lanIPv4() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- Host signaling ----------
function startHost() {
  stopNet();
  currentPin = String(Math.floor(100000 + Math.random() * 900000));
  wss = new WebSocketServer({ port: SIGNAL_PORT, host: '0.0.0.0' });
  wss.on('connection', (ws) => {
    let authed = false;
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!authed) {
        if (msg.type === 'auth' && msg.pin === currentPin && !hostPeer) {
          authed = true;
          hostPeer = ws;
          ws.send(JSON.stringify({ type: 'auth-ok' }));
          send('peer:connected', {});
        } else {
          ws.send(JSON.stringify({ type: 'auth-fail' }));
          ws.close();
        }
        return;
      }
      if (msg.type === 'signal') send('signal:recv', msg.msg);
    });
    ws.on('close', () => {
      if (ws === hostPeer) { hostPeer = null; send('peer:closed', {}); }
    });
    ws.on('error', () => {});
  });
  wss.on('error', (e) => send('net:error', { where: 'host', message: String(e && e.message || e) }));
  return { pin: currentPin, port: SIGNAL_PORT, ips: lanIPv4() };
}

// ---------- Client signaling ----------
function connectClient({ ip, port, pin }) {
  return new Promise((resolve) => {
    stopNet();
    let settled = false;
    const url = `ws://${ip}:${port || SIGNAL_PORT}`;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { resolve({ ok: false, reason: String(e.message) }); return; }
    clientWs = ws;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { ws.close(); } catch {} resolve({ ok: false, reason: 'timeout' }); }
    }, 8000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', pin })));
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'auth-ok') {
        if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: true }); }
        send('client:authed', {});
      } else if (msg.type === 'auth-fail') {
        if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, reason: 'bad-pin' }); }
        try { ws.close(); } catch {}
      } else if (msg.type === 'signal') {
        send('signal:recv', msg.msg);
      }
    });
    ws.on('close', () => { send('peer:closed', {}); });
    ws.on('error', (e) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, reason: String(e && e.message || e) }); }
    });
  });
}

function relaySignal(msg) {
  const target = hostPeer || clientWs;
  if (target && target.readyState === WebSocket.OPEN) {
    target.send(JSON.stringify({ type: 'signal', msg }));
  }
}

function stopNet() {
  try { if (hostPeer) hostPeer.close(); } catch {}
  try { if (clientWs) clientWs.close(); } catch {}
  try { if (wss) wss.close(); } catch {}
  hostPeer = null; clientWs = null; wss = null;
}

// ---------- IPC ----------
ipcMain.handle('sys:getIps', () => lanIPv4());
ipcMain.handle('host:start', () => startHost());
ipcMain.handle('host:stop', () => { stopNet(); return true; });
ipcMain.handle('client:connect', (_e, args) => connectClient(args));
ipcMain.handle('client:disconnect', () => { stopNet(); return true; });
ipcMain.on('signal:send', (_e, msg) => relaySignal(msg));

ipcMain.on('input:inject', async (_e, event) => {
  try {
    const { inject } = require('./input');
    const primary = screen.getPrimaryDisplay();
    await inject(event, { width: primary.size.width, height: primary.size.height });
  } catch (err) {
    send('net:error', { where: 'input', message: String(err && err.message || err) });
  }
});

ipcMain.handle('clip:read', () => clipboard.readText());
ipcMain.handle('clip:write', (_e, text) => { clipboard.writeText(String(text || '')); return true; });

ipcMain.handle('file:save', (_e, { name, data }) => {
  const dir = app.getPath('downloads');
  let safe = String(name || 'file').replace(/[\\/:*?"<>|]/g, '_');
  let dest = path.join(dir, safe);
  let i = 1;
  while (fs.existsSync(dest)) {
    const ext = path.extname(safe);
    const base = path.basename(safe, ext);
    dest = path.join(dir, `${base} (${i++})${ext}`);
  }
  fs.writeFileSync(dest, Buffer.from(data));
  return dest;
});

ipcMain.handle('file:reveal', (_e, p) => { shell.showItemInFolder(p); return true; });
ipcMain.handle('link:open', (_e, url) => {
  const u = String(url || '');
  if (/^https?:\/\//i.test(u)) { shell.openExternal(u); return true; }
  return false;
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { stopNet(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', stopNet);
