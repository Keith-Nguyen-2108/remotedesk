# RemoteDesk — LAN MVP Implementation Plan (M1–M4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal cross-platform (macOS + Windows) remote-desktop app — one machine views and controls another over the same LAN, plus file/image transfer, link sending and clipboard sync — and ship unsigned `.dmg` + `.exe` installers for self-testing.

**Architecture:** One Electron app that can act in two roles. The **Host** (machine being controlled) runs a tiny WebSocket signaling server on the LAN, broadcasts a UDP discovery beacon, captures its screen via `getDisplayMedia`, and injects incoming mouse/keyboard events into the OS with nut.js. The **Client** (controlling machine) discovers or is given the host's IP, authenticates with a 6-digit PIN via HMAC challenge–response, then a direct WebRTC `RTCPeerConnection` carries the screen video plus three data channels: `input` (mouse/keyboard), `ctrl` (JSON: links, clipboard, file metadata) and `file` (raw binary chunks). No external server is needed in this plan — internet/TURN support is deliberately deferred to a separate plan (see "Out of Scope").

**Tech Stack:** Electron 44 · TypeScript · electron-vite (build) · plain TS/DOM renderer (no UI framework, keeps the app light) · WebRTC (built into Chromium) · `ws` (signaling) · `node:dgram` (LAN discovery) · `@nut-tree-fork/nut-js` (input injection) · Vitest (unit/integration tests) · electron-builder + GitHub Actions (installers for both OSes)

---

## Critical context the implementer must know

Read this whole section before Task 1. These are the non-obvious facts that decide whether the app works at all.

### 1. nut.js package name — do NOT use `@nut-tree/nut-js`

`@nut-tree/nut-js` is **no longer published on the public npm registry** (verified: `npm view @nut-tree/nut-js version` → 404). It moved behind a private/paid registry. Use the community fork:

- `@nut-tree-fork/nut-js@4.2.6` — the API used in this plan (`mouse`, `keyboard`, `screen`, `Key`, `Button`, `Point`, `straightTo`)
- it pulls `@nut-tree-fork/libnut@4.2.6`, a **native module with per-platform prebuilt binaries**

Consequence (as written): a macOS `npm install` was expected to fetch only the macOS binary, making a Windows `.exe` unbuildable from a Mac.

> **Correction, verified during implementation:** this was too pessimistic. The fork ships its native code as one package per platform (`libnut-darwin`, `libnut-win32`, `libnut-linux`) and npm installs **all three** regardless of host OS, so `npm run dist:win` on macOS produces an `.exe` containing a genuine PE32+ `libnut.node`. The macOS-only permission shim that gets bundled with it is required inside a try/catch and short-circuits on non-darwin platforms. CI is still set up (Task 21) and is the right way to get natively-built, hardware-verified artifacts.** That is why Task 19 sets up a GitHub Actions matrix build (macOS runner → `.dmg`, Windows runner → `.exe`). A local Windows build script is also provided for the case where a Windows machine is available.

Fallback if the fork ever breaks: `@jitsi/robotjs@0.6.24` (maintained robotjs fork). The input layer in Task 11 is deliberately isolated behind one module (`src/main/input.ts`) so that swap touches exactly one file.

### 2. macOS permissions are mandatory and cannot be bypassed

A Mac acting as **Host** needs two permissions granted by hand in System Settings → Privacy & Security:

- **Screen Recording** → for `getDisplayMedia`. Check with `systemPreferences.getMediaAccessStatus('screen')`.
- **Accessibility** → for nut.js input injection. Check with `systemPreferences.isTrustedAccessibilityClient(false)`.

Task 17 builds a gate screen that detects both and deep-links to the right settings pane. There is no API to grant them programmatically — by design, this is Apple's TCC security model.

Extra macOS gotcha: TCC grants are keyed to the app's code signature + path. An **unsigned** rebuild can lose its grant and need re-adding. Task 19 therefore applies ad-hoc signing (`identity: null` in electron-builder produces an ad-hoc signed bundle) which keeps grants reasonably stable across rebuilds of the same installed app.

### 3. Windows notes

- Screen capture and input injection work with no permission prompt.
- **UAC-elevated windows** (Task Manager, installers, admin consoles) cannot receive injected input unless RemoteDesk itself runs elevated. Documented limitation for v1, not a bug.
- SmartScreen will warn on the unsigned `.exe`: *More info → Run anyway*.

### 4. Coordinates: always send normalized, never pixels

The client's `<video>` element size ≠ the host's screen resolution, and on Retina/scaled displays the captured pixel size ≠ nut.js's logical coordinate space. Sending raw pixels guarantees a misaligned cursor.

Rule for this codebase: the client converts a pointer position into **normalized `{x, y}` in 0..1 of the host screen**, and the host multiplies by `screen.width()` / `screen.height()` from nut.js. The conversion must also undo the letterboxing introduced by `object-fit: contain`. Task 8 implements and tests exactly this.

### 5. Keyboard: `KeyboardEvent.code` → nut.js `Key`, verified by test

The client sends the physical key identity (`event.code`, e.g. `"KeyA"`, `"ShiftLeft"`, `"Digit1"`) and never a character. The host maps it to a nut.js `Key` member. Modifier keys are sent as ordinary keydown/keyup events, so the host never has to track modifier state separately.

Because a typo in that mapping table fails silently at runtime, Task 9 includes a test that iterates every mapped name and asserts it exists in nut.js's `Key` enum. Trust that test, not this document, for the exact member names.

### 6. Electron screen capture uses `setDisplayMediaRequestHandler`

Modern Electron routes screen capture through main-process consent. Main registers a handler that answers with the `desktopCapturer` source the user picked; the renderer then calls plain `navigator.mediaDevices.getDisplayMedia()`. The legacy `chromeMediaSource: 'desktop'` constraint path is not used here.

### 7. Out of scope for this plan (deliberately)

- Internet connections, ID-based pairing, signaling server on a VPS, TURN relay → **a separate plan**, written after M4 ships and the LAN path is proven.
- Audio streaming, multi-monitor simultaneous view, session recording, multiple concurrent clients, unattended access, notarized/signed installers.

---

## File Structure

Every file has one responsibility. Everything pure and testable lives in `src/shared/` with no Electron import, so Vitest can run it in plain Node.

```
remotedesk/
├── package.json                      npm scripts, deps
├── tsconfig.json                     TS config (strict)
├── electron.vite.config.ts           build config for main/preload/renderer
├── vitest.config.ts                  test config
├── electron-builder.yml              installer config (dmg + nsis)
├── .github/workflows/build.yml       CI matrix: macOS + Windows installers
├── build/
│   └── icon.png                      1024x1024 app icon source
├── src/
│   ├── shared/                       PURE LOGIC — no electron, fully unit-tested
│   │   ├── protocol.ts               message shapes + runtime validators + constants
│   │   ├── auth.ts                   PIN generation, HMAC challenge–response
│   │   ├── coords.ts                 element point → normalized → host pixels
│   │   ├── keymap.ts                 KeyboardEvent.code → nut.js Key name
│   │   ├── filechunk.ts              file chunker + reassembler
│   │   ├── clipboard-sync.ts         echo-free clipboard state machine
│   │   └── url-guard.ts              safe-link validation
│   ├── main/                         Electron main process
│   │   ├── index.ts                  app bootstrap, window, role switching
│   │   ├── ipc.ts                    all ipcMain handlers in one registry
│   │   ├── capture.ts                desktopCapturer sources + display media handler
│   │   ├── input.ts                  nut.js injection service (the only nut.js import)
│   │   ├── permissions.ts            macOS permission checks + settings deep links
│   │   ├── signaling-server.ts       host-side WebSocket server (auth + relay)
│   │   ├── signaling-client.ts       client-side WebSocket connector
│   │   ├── discovery.ts              UDP query/reply host discovery
│   │   └── clipboard.ts              Electron clipboard read/write adapter
│   ├── preload/
│   │   └── index.ts                  contextBridge: the app's only main↔renderer API
│   └── renderer/
│       ├── index.html                single page, two panes
│       ├── main.ts                   role routing + app shell
│       ├── styles.css                minimal styling
│       ├── rtc/
│       │   ├── peer.ts               RTCPeerConnection + channel setup helper
│       │   ├── host-session.ts       host role: capture, offer, receive input
│       │   └── client-session.ts     client role: answer, render, send input
│       └── ui/
│           ├── host-view.ts          host screen: PIN, status, permission gate
│           ├── client-view.ts        client screen: discovery list, connect form
│           ├── remote-screen.ts      <video> + pointer/key capture
│           └── transfer-panel.ts     file drop zone, progress, link box
└── tests/
    └── shared/                       one test file per shared module
        ├── protocol.test.ts
        ├── auth.test.ts
        ├── coords.test.ts
        ├── keymap.test.ts
        ├── filechunk.test.ts
        ├── clipboard-sync.test.ts
        └── url-guard.test.ts
    └── main/
        ├── signaling.test.ts         real ws client against real server
        └── discovery.test.ts         real UDP sockets on loopback
```

---

## Milestones

| Milestone | Tasks | Definition of done |
|---|---|---|
| **M1** Skeleton + view-only | 1–7 | Client sees host's live screen over LAN, PIN-protected |
| **M2** Control | 8–11 | Mouse + keyboard drive the host machine |
| **M3** Side channels | 12–16 | File/image transfer, link sending, clipboard sync |
| **M4** Ship | 17–19 | Permission gate, session approval, `.dmg` + `.exe` installers |

---
# M1 — Skeleton + view-only screen sharing

### Task 1: Project scaffold that opens a window

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `electron.vite.config.ts`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/main/index.ts`
- Create: `src/preload/index.ts`
- Create: `src/renderer/index.html`
- Create: `src/renderer/main.ts`
- Create: `src/renderer/styles.css`

- [ ] **Step 1: Initialize the repo**

```bash
git init
node -v   # expect v20+ ; this plan was written against v24.4.0
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "remotedesk",
  "version": "0.1.0",
  "description": "Personal LAN remote desktop",
  "main": "out/main/index.js",
  "license": "UNLICENSED",
  "private": true,
  "scripts": {
    "dev": "electron-vite dev",
    "typecheck": "tsc --noEmit",
    "build": "npm run typecheck && electron-vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "dist:mac": "npm run build && electron-builder --mac",
    "dist:win": "npm run build && electron-builder --win",
    "postinstall": "electron-builder install-app-deps"
  },
  "dependencies": {
    "@nut-tree-fork/nut-js": "^4.2.6",
    "ws": "^8.21.3"
  },
  "devDependencies": {
    "@types/node": "^24.4.0",
    "@types/ws": "^8.18.1",
    "electron": "^44.4.2",
    "electron-builder": "^26.15.3",
    "electron-vite": "^5.0.0",
    "typescript": "^5.9.0",
    "vite": "^8.3.0",
    "vitest": "^5.0.1"
  }
}
```

- [ ] **Step 3: Install dependencies**

```bash
npm install
```

Expected: install completes; `node_modules/@nut-tree-fork/libnut` contains a prebuilt binary for this platform. If `npm install` fails on peer versions between `electron-vite` and `vite`, run `npm install -D vite@^8 --legacy-peer-deps` and continue.

- [ ] **Step 4: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src", "tests", "*.config.ts"]
}
```

- [ ] **Step 5: Write `electron.vite.config.ts`**

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {}
})
```

- [ ] **Step 6: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
})
```

- [ ] **Step 7: Write `.gitignore`**

```
node_modules/
out/
dist/
.DS_Store
*.log
```

- [ ] **Step 8: Write the minimal main process, `src/main/index.ts`**

```ts
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
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

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

- [ ] **Step 9: Write the placeholder preload, `src/preload/index.ts`**

```ts
import { contextBridge } from 'electron'

const api = {
  version: '0.1.0'
}

contextBridge.exposeInMainWorld('rd', api)

export type RdApi = typeof api
```

- [ ] **Step 10: Write `src/renderer/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'"
    />
    <title>RemoteDesk</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

- [ ] **Step 11: Write `src/renderer/main.ts` and `src/renderer/styles.css`**

```ts
const app = document.querySelector<HTMLDivElement>('#app')
if (app) app.textContent = 'RemoteDesk scaffold OK'
```

```css
:root { color-scheme: light dark; font-family: system-ui, -apple-system, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; }
```

- [ ] **Step 12: Run the app and confirm the window opens**

Run: `npm run dev`
Expected: a window titled *RemoteDesk* showing "RemoteDesk scaffold OK". Close it.

- [ ] **Step 13: Verify typecheck and the (empty) test run**

```bash
npm run typecheck && npm test
```
Expected: typecheck passes; Vitest reports "No test files found" (exit code may be 1 — acceptable until Task 2 adds the first test).

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "chore: scaffold electron + vite + vitest app shell"
```

---

### Task 2: Wire protocol — message types and validators

Every byte crossing the network is validated before use. A remote peer that can move your mouse must never be trusted to send well-formed data.

**Files:**
- Create: `src/shared/protocol.ts`
- Test: `tests/shared/protocol.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import {
  DISCOVERY_MAGIC,
  FILE_CHUNK_SIZE,
  PROTOCOL_VERSION,
  parseCtrlMessage,
  parseInputMessage,
  parseJson,
  parseSignalMessage
} from '../../src/shared/protocol'

describe('constants', () => {
  it('pins the wire version and chunk size', () => {
    expect(PROTOCOL_VERSION).toBe(1)
    expect(FILE_CHUNK_SIZE).toBe(16 * 1024)
    expect(DISCOVERY_MAGIC).toBe('remotedesk-discover-v1')
  })
})

describe('parseJson', () => {
  it('returns null for malformed JSON instead of throwing', () => {
    expect(parseJson('{nope')).toBeNull()
  })

  it('parses valid JSON', () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 })
  })
})

describe('parseInputMessage', () => {
  it('accepts a normalized mouse move', () => {
    expect(parseInputMessage({ t: 'move', x: 0.5, y: 0.25 })).toEqual({
      t: 'move',
      x: 0.5,
      y: 0.25
    })
  })

  it('rejects coordinates outside 0..1', () => {
    expect(parseInputMessage({ t: 'move', x: 1.5, y: 0 })).toBeNull()
    expect(parseInputMessage({ t: 'move', x: -0.1, y: 0 })).toBeNull()
  })

  it('rejects non-finite coordinates', () => {
    expect(parseInputMessage({ t: 'move', x: Number.NaN, y: 0 })).toBeNull()
  })

  it('accepts mouse down/up with a known button', () => {
    expect(parseInputMessage({ t: 'down', b: 'left', x: 0, y: 0 })).toEqual({
      t: 'down',
      b: 'left',
      x: 0,
      y: 0
    })
    expect(parseInputMessage({ t: 'up', b: 'middle', x: 1, y: 1 })?.t).toBe('up')
  })

  it('rejects an unknown mouse button', () => {
    expect(parseInputMessage({ t: 'down', b: 'fourth', x: 0, y: 0 })).toBeNull()
  })

  it('accepts a wheel event', () => {
    expect(parseInputMessage({ t: 'wheel', dx: 0, dy: -120 })?.t).toBe('wheel')
  })

  it('accepts key events and rejects absurd key codes', () => {
    expect(parseInputMessage({ t: 'keydown', code: 'KeyA' })).toEqual({
      t: 'keydown',
      code: 'KeyA'
    })
    expect(parseInputMessage({ t: 'keyup', code: 'ShiftLeft' })?.t).toBe('keyup')
    expect(parseInputMessage({ t: 'keydown', code: 'x'.repeat(64) })).toBeNull()
    expect(parseInputMessage({ t: 'keydown', code: '' })).toBeNull()
  })

  it('rejects unknown message types and non-objects', () => {
    expect(parseInputMessage({ t: 'shutdown' })).toBeNull()
    expect(parseInputMessage('move')).toBeNull()
    expect(parseInputMessage(null)).toBeNull()
    expect(parseInputMessage([{ t: 'move', x: 0, y: 0 }])).toBeNull()
  })
})

describe('parseCtrlMessage', () => {
  it('accepts a link message', () => {
    expect(parseCtrlMessage({ t: 'link', url: 'https://example.com' })).toEqual({
      t: 'link',
      url: 'https://example.com'
    })
  })

  it('accepts clipboard text and image', () => {
    expect(parseCtrlMessage({ t: 'clip-text', text: 'hello' })?.t).toBe('clip-text')
    expect(parseCtrlMessage({ t: 'clip-image', dataUrl: 'data:image/png;base64,AA' })?.t).toBe(
      'clip-image'
    )
  })

  it('accepts file-begin and file-end', () => {
    expect(
      parseCtrlMessage({ t: 'file-begin', id: 'f1', name: 'a.png', size: 10, mime: 'image/png' })
    ).toEqual({ t: 'file-begin', id: 'f1', name: 'a.png', size: 10, mime: 'image/png' })
    expect(parseCtrlMessage({ t: 'file-end', id: 'f1', sha256: 'ab12' })?.t).toBe('file-end')
  })

  it('rejects a negative or oversized file size', () => {
    expect(
      parseCtrlMessage({ t: 'file-begin', id: 'f1', name: 'a', size: -1, mime: '' })
    ).toBeNull()
    expect(
      parseCtrlMessage({ t: 'file-begin', id: 'f1', name: 'a', size: 5e10, mime: '' })
    ).toBeNull()
  })

  it('accepts screen-info', () => {
    expect(parseCtrlMessage({ t: 'screen-info', width: 1920, height: 1080 })?.t).toBe('screen-info')
  })
})

describe('parseSignalMessage', () => {
  it('accepts the handshake messages', () => {
    expect(
      parseSignalMessage({ t: 'challenge', challenge: 'ab', hostName: 'Mac', version: 1 })?.t
    ).toBe('challenge')
    expect(parseSignalMessage({ t: 'auth', proof: 'cd', clientName: 'PC', version: 1 })?.t).toBe(
      'auth'
    )
    expect(parseSignalMessage({ t: 'auth-ok' })).toEqual({ t: 'auth-ok' })
  })

  it('accepts sdp and ice payloads', () => {
    expect(parseSignalMessage({ t: 'offer', sdp: 'v=0' })?.t).toBe('offer')
    expect(parseSignalMessage({ t: 'answer', sdp: 'v=0' })?.t).toBe('answer')
    const ice = parseSignalMessage({
      t: 'ice',
      candidate: { candidate: 'candidate:1 1 udp', sdpMid: '0', sdpMLineIndex: 0 }
    })
    expect(ice?.t).toBe('ice')
  })

  it('rejects an ice payload with a non-string candidate', () => {
    expect(parseSignalMessage({ t: 'ice', candidate: { candidate: 5 } })).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/shared/protocol.test.ts`
Expected: FAIL — "Failed to resolve import ... src/shared/protocol".

- [ ] **Step 3: Write `src/shared/protocol.ts`**

```ts
export const PROTOCOL_VERSION = 1

export const DEFAULT_SIGNAL_PORT = 45789
export const DISCOVERY_PORT = 45790
export const DISCOVERY_MAGIC = 'remotedesk-discover-v1'

export const FILE_CHUNK_SIZE = 16 * 1024
/** Stop pumping chunks once the data channel has this much queued. */
export const DATA_CHANNEL_HIGH_WATER = 4 * 1024 * 1024
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
export const MAX_KEY_CODE_LENGTH = 32
export const AUTH_TIMEOUT_MS = 10_000

export type MouseButton = 'left' | 'right' | 'middle'

export type InputMessage =
  | { t: 'move'; x: number; y: number }
  | { t: 'down'; b: MouseButton; x: number; y: number }
  | { t: 'up'; b: MouseButton; x: number; y: number }
  | { t: 'wheel'; dx: number; dy: number }
  | { t: 'keydown'; code: string }
  | { t: 'keyup'; code: string }

export type CtrlMessage =
  | { t: 'link'; url: string }
  | { t: 'clip-text'; text: string }
  | { t: 'clip-image'; dataUrl: string }
  | { t: 'file-begin'; id: string; name: string; size: number; mime: string }
  | { t: 'file-end'; id: string; sha256: string }
  | { t: 'file-ack'; id: string; ok: boolean; message?: string }
  | { t: 'screen-info'; width: number; height: number }

export interface IceCandidatePayload {
  candidate: string
  sdpMid?: string | null
  sdpMLineIndex?: number | null
  usernameFragment?: string | null
}

export type SignalMessage =
  | { t: 'challenge'; challenge: string; hostName: string; version: number }
  | { t: 'auth'; proof: string; clientName: string; version: number }
  | { t: 'auth-ok' }
  | { t: 'offer'; sdp: string }
  | { t: 'answer'; sdp: string }
  | { t: 'ice'; candidate: IceCandidatePayload }
  | { t: 'bye'; reason: string }

const MOUSE_BUTTONS: readonly string[] = ['left', 'right', 'middle']

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isStr(v: unknown): v is string {
  return typeof v === 'string'
}

function isUnit(v: unknown): v is number {
  return isNum(v) && v >= 0 && v <= 1
}

function isKeyCode(v: unknown): v is string {
  return isStr(v) && v.length > 0 && v.length <= MAX_KEY_CODE_LENGTH
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function parseInputMessage(raw: unknown): InputMessage | null {
  if (!isObj(raw)) return null
  switch (raw.t) {
    case 'move':
      return isUnit(raw.x) && isUnit(raw.y) ? { t: 'move', x: raw.x, y: raw.y } : null
    case 'down':
    case 'up':
      return isUnit(raw.x) && isUnit(raw.y) && isStr(raw.b) && MOUSE_BUTTONS.includes(raw.b)
        ? { t: raw.t, b: raw.b as MouseButton, x: raw.x, y: raw.y }
        : null
    case 'wheel':
      return isNum(raw.dx) && isNum(raw.dy) ? { t: 'wheel', dx: raw.dx, dy: raw.dy } : null
    case 'keydown':
    case 'keyup':
      return isKeyCode(raw.code) ? { t: raw.t, code: raw.code } : null
    default:
      return null
  }
}

export function parseCtrlMessage(raw: unknown): CtrlMessage | null {
  if (!isObj(raw)) return null
  switch (raw.t) {
    case 'link':
      return isStr(raw.url) ? { t: 'link', url: raw.url } : null
    case 'clip-text':
      return isStr(raw.text) ? { t: 'clip-text', text: raw.text } : null
    case 'clip-image':
      return isStr(raw.dataUrl) ? { t: 'clip-image', dataUrl: raw.dataUrl } : null
    case 'file-begin':
      return isStr(raw.id) &&
        isStr(raw.name) &&
        isStr(raw.mime) &&
        isNum(raw.size) &&
        raw.size >= 0 &&
        raw.size <= MAX_FILE_BYTES
        ? { t: 'file-begin', id: raw.id, name: raw.name, size: raw.size, mime: raw.mime }
        : null
    case 'file-end':
      return isStr(raw.id) && isStr(raw.sha256) ? { t: 'file-end', id: raw.id, sha256: raw.sha256 } : null
    case 'file-ack':
      return isStr(raw.id) && typeof raw.ok === 'boolean'
        ? {
            t: 'file-ack',
            id: raw.id,
            ok: raw.ok,
            ...(isStr(raw.message) ? { message: raw.message } : {})
          }
        : null
    case 'screen-info':
      return isNum(raw.width) && isNum(raw.height) && raw.width > 0 && raw.height > 0
        ? { t: 'screen-info', width: raw.width, height: raw.height }
        : null
    default:
      return null
  }
}

function parseIce(raw: unknown): IceCandidatePayload | null {
  if (!isObj(raw) || !isStr(raw.candidate)) return null
  return {
    candidate: raw.candidate,
    sdpMid: isStr(raw.sdpMid) ? raw.sdpMid : null,
    sdpMLineIndex: isNum(raw.sdpMLineIndex) ? raw.sdpMLineIndex : null,
    usernameFragment: isStr(raw.usernameFragment) ? raw.usernameFragment : null
  }
}

export function parseSignalMessage(raw: unknown): SignalMessage | null {
  if (!isObj(raw)) return null
  switch (raw.t) {
    case 'challenge':
      return isStr(raw.challenge) && isStr(raw.hostName) && isNum(raw.version)
        ? { t: 'challenge', challenge: raw.challenge, hostName: raw.hostName, version: raw.version }
        : null
    case 'auth':
      return isStr(raw.proof) && isStr(raw.clientName) && isNum(raw.version)
        ? { t: 'auth', proof: raw.proof, clientName: raw.clientName, version: raw.version }
        : null
    case 'auth-ok':
      return { t: 'auth-ok' }
    case 'offer':
    case 'answer':
      return isStr(raw.sdp) ? { t: raw.t, sdp: raw.sdp } : null
    case 'ice': {
      const candidate = parseIce(raw.candidate)
      return candidate ? { t: 'ice', candidate } : null
    }
    case 'bye':
      return isStr(raw.reason) ? { t: 'bye', reason: raw.reason } : null
    default:
      return null
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/shared/protocol.test.ts`
Expected: PASS, all assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/shared/protocol.ts tests/shared/protocol.test.ts
git commit -m "feat: wire protocol types with strict runtime validation"
```

---

### Task 3: PIN authentication via HMAC challenge–response

The PIN is never sent over the wire. The host sends a random challenge; the client returns `HMAC-SHA256(pin, challenge)`. A passive listener on the LAN learns nothing reusable.

**Files:**
- Create: `src/shared/auth.ts`
- Test: `tests/shared/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { computeProof, generateChallenge, generatePin, verifyProof } from '../../src/shared/auth'

describe('generatePin', () => {
  it('always returns exactly six digits', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePin()).toMatch(/^\d{6}$/)
    }
  })

  it('is not constant', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generatePin()))
    expect(seen.size).toBeGreaterThan(1)
  })
})

describe('generateChallenge', () => {
  it('returns 64 hex characters and never repeats', () => {
    const a = generateChallenge()
    const b = generateChallenge()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})

describe('computeProof / verifyProof', () => {
  it('is deterministic for the same pin and challenge', () => {
    const c = generateChallenge()
    expect(computeProof('123456', c)).toBe(computeProof('123456', c))
  })

  it('accepts the correct proof', () => {
    const c = generateChallenge()
    expect(verifyProof('123456', c, computeProof('123456', c))).toBe(true)
  })

  it('rejects a proof made with the wrong pin', () => {
    const c = generateChallenge()
    expect(verifyProof('123456', c, computeProof('654321', c))).toBe(false)
  })

  it('rejects a proof made for a different challenge (no replay)', () => {
    const proof = computeProof('123456', generateChallenge())
    expect(verifyProof('123456', generateChallenge(), proof)).toBe(false)
  })

  it('rejects garbage without throwing', () => {
    const c = generateChallenge()
    expect(verifyProof('123456', c, undefined)).toBe(false)
    expect(verifyProof('123456', c, 42)).toBe(false)
    expect(verifyProof('123456', c, '')).toBe(false)
    expect(verifyProof('123456', c, 'short')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/shared/auth.test.ts`
Expected: FAIL — cannot resolve `src/shared/auth`.

- [ ] **Step 3: Write `src/shared/auth.ts`**

```ts
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

/** Six-digit session PIN, shown on the host and typed on the client. */
export function generatePin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/** Fresh random challenge per connection attempt — this is what blocks replay. */
export function generateChallenge(): string {
  return randomBytes(32).toString('hex')
}

export function computeProof(pin: string, challenge: string): string {
  return createHmac('sha256', pin).update(challenge).digest('hex')
}

export function verifyProof(pin: string, challenge: string, proof: unknown): boolean {
  if (typeof proof !== 'string') return false
  const expected = Buffer.from(computeProof(pin, challenge), 'utf8')
  const given = Buffer.from(proof, 'utf8')
  if (expected.length !== given.length) return false
  return timingSafeEqual(expected, given)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/shared/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/auth.ts tests/shared/auth.test.ts
git commit -m "feat: PIN auth with HMAC challenge-response"
```

---

### Task 4: Host-side signaling server

The host owns a WebSocket server. It admits exactly one authenticated client, then relays SDP/ICE between that client and the host's own renderer.

**Files:**
- Create: `src/main/signaling-server.ts`
- Test: `tests/main/signaling.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { computeProof } from '../../src/shared/auth'
import { PROTOCOL_VERSION, parseJson, parseSignalMessage } from '../../src/shared/protocol'
import {
  CLOSE_AUTH_FAILED,
  CLOSE_BAD_VERSION,
  CLOSE_BUSY,
  SignalingServer
} from '../../src/main/signaling-server'
import type { SignalMessage } from '../../src/shared/protocol'

let server: SignalingServer | null = null

afterEach(async () => {
  await server?.stop()
  server = null
})

/** Resolve with the next parsed signal message, or reject on close/timeout. */
function nextMessage(ws: WebSocket): Promise<SignalMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), 3000)
    ws.once('message', (data) => {
      clearTimeout(timer)
      const msg = parseSignalMessage(parseJson(data.toString()))
      if (!msg) reject(new Error(`unparseable: ${data.toString()}`))
      else resolve(msg)
    })
  })
}

function nextClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for close')), 3000)
    ws.once('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

async function startServer(overrides: Partial<{ pin: string }> = {}) {
  const received: SignalMessage[] = []
  const authed: string[] = []
  const s = new SignalingServer({
    port: 0,
    pin: overrides.pin ?? '123456',
    hostName: 'TestHost',
    onClientAuthenticated: (name) => authed.push(name),
    onMessage: (msg) => received.push(msg),
    onClientGone: () => authed.push('<gone>')
  })
  const port = await s.start()
  server = s
  return { s, port, received, authed }
}

describe('SignalingServer', () => {
  it('greets a new connection with a challenge', async () => {
    const { port } = await startServer()
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const msg = await nextMessage(ws)
    expect(msg.t).toBe('challenge')
    if (msg.t === 'challenge') {
      expect(msg.hostName).toBe('TestHost')
      expect(msg.version).toBe(PROTOCOL_VERSION)
      expect(msg.challenge).toMatch(/^[0-9a-f]{64}$/)
    }
    ws.close()
  })

  it('accepts a client that proves the right pin', async () => {
    const { port, authed } = await startServer({ pin: '111222' })
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const challenge = await nextMessage(ws)
    if (challenge.t !== 'challenge') throw new Error('expected challenge')
    ws.send(
      JSON.stringify({
        t: 'auth',
        proof: computeProof('111222', challenge.challenge),
        clientName: 'Laptop',
        version: PROTOCOL_VERSION
      })
    )
    expect((await nextMessage(ws)).t).toBe('auth-ok')
    expect(authed).toContain('Laptop')
    ws.close()
  })

  it('closes with CLOSE_AUTH_FAILED on a wrong pin', async () => {
    const { port } = await startServer({ pin: '111222' })
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const challenge = await nextMessage(ws)
    if (challenge.t !== 'challenge') throw new Error('expected challenge')
    ws.send(
      JSON.stringify({
        t: 'auth',
        proof: computeProof('999999', challenge.challenge),
        clientName: 'Attacker',
        version: PROTOCOL_VERSION
      })
    )
    expect(await nextClose(ws)).toBe(CLOSE_AUTH_FAILED)
  })

  it('closes with CLOSE_BAD_VERSION on a protocol mismatch', async () => {
    const { port } = await startServer()
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const challenge = await nextMessage(ws)
    if (challenge.t !== 'challenge') throw new Error('expected challenge')
    ws.send(
      JSON.stringify({
        t: 'auth',
        proof: computeProof('123456', challenge.challenge),
        clientName: 'Old',
        version: 99
      })
    )
    expect(await nextClose(ws)).toBe(CLOSE_BAD_VERSION)
  })

  it('refuses signaling traffic before auth', async () => {
    const { port, received } = await startServer()
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    await nextMessage(ws)
    ws.send(JSON.stringify({ t: 'answer', sdp: 'v=0' }))
    expect(await nextClose(ws)).toBe(CLOSE_AUTH_FAILED)
    expect(received).toHaveLength(0)
  })

  it('rejects a second client while one is connected', async () => {
    const { port } = await startServer()
    const first = new WebSocket(`ws://127.0.0.1:${port}`)
    const challenge = await nextMessage(first)
    if (challenge.t !== 'challenge') throw new Error('expected challenge')
    first.send(
      JSON.stringify({
        t: 'auth',
        proof: computeProof('123456', challenge.challenge),
        clientName: 'First',
        version: PROTOCOL_VERSION
      })
    )
    await nextMessage(first)

    const second = new WebSocket(`ws://127.0.0.1:${port}`)
    expect(await nextClose(second)).toBe(CLOSE_BUSY)
    first.close()
  })

  it('relays client signaling messages to the app and back', async () => {
    const { s, port, received } = await startServer()
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const challenge = await nextMessage(ws)
    if (challenge.t !== 'challenge') throw new Error('expected challenge')
    ws.send(
      JSON.stringify({
        t: 'auth',
        proof: computeProof('123456', challenge.challenge),
        clientName: 'Laptop',
        version: PROTOCOL_VERSION
      })
    )
    await nextMessage(ws)

    ws.send(JSON.stringify({ t: 'answer', sdp: 'v=0 answer' }))
    await new Promise((r) => setTimeout(r, 100))
    expect(received).toEqual([{ t: 'answer', sdp: 'v=0 answer' }])

    s.send({ t: 'offer', sdp: 'v=0 offer' })
    const relayed = await nextMessage(ws)
    expect(relayed).toEqual({ t: 'offer', sdp: 'v=0 offer' })
    ws.close()
  })

  it('drops malformed frames without closing an authenticated session', async () => {
    const { port, received } = await startServer()
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const challenge = await nextMessage(ws)
    if (challenge.t !== 'challenge') throw new Error('expected challenge')
    ws.send(
      JSON.stringify({
        t: 'auth',
        proof: computeProof('123456', challenge.challenge),
        clientName: 'Laptop',
        version: PROTOCOL_VERSION
      })
    )
    await nextMessage(ws)

    ws.send('{not json')
    ws.send(JSON.stringify({ t: 'launch-missiles' }))
    ws.send(JSON.stringify({ t: 'answer', sdp: 'v=0 ok' }))
    await new Promise((r) => setTimeout(r, 100))
    expect(received).toEqual([{ t: 'answer', sdp: 'v=0 ok' }])
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/main/signaling.test.ts`
Expected: FAIL — cannot resolve `src/main/signaling-server`.

- [ ] **Step 3: Write `src/main/signaling-server.ts`**

```ts
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { generateChallenge, verifyProof } from '../shared/auth'
import {
  AUTH_TIMEOUT_MS,
  PROTOCOL_VERSION,
  parseJson,
  parseSignalMessage,
  type SignalMessage
} from '../shared/protocol'

export const CLOSE_AUTH_FAILED = 4001
export const CLOSE_BUSY = 4002
export const CLOSE_BAD_VERSION = 4003
export const CLOSE_REJECTED = 4004

export interface SignalingServerOptions {
  /** 0 picks a free port; production uses DEFAULT_SIGNAL_PORT. */
  port: number
  pin: string
  hostName: string
  onClientAuthenticated: (clientName: string) => void
  onMessage: (msg: SignalMessage) => void
  onClientGone: () => void
  /** Optional human approval gate, applied after the PIN checks out. */
  approveClient?: (clientName: string) => Promise<boolean>
}

export class SignalingServer {
  private http: Server | null = null
  private wss: WebSocketServer | null = null
  private active: WebSocket | null = null

  constructor(private readonly opts: SignalingServerOptions) {}

  async start(): Promise<number> {
    const http = createServer()
    const wss = new WebSocketServer({ server: http })
    wss.on('connection', (ws) => this.handleConnection(ws))
    this.http = http
    this.wss = wss

    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(this.opts.port, '0.0.0.0', () => resolve())
    })
    return (http.address() as AddressInfo).port
  }

  hasClient(): boolean {
    return this.active !== null && this.active.readyState === WebSocket.OPEN
  }

  send(msg: SignalMessage): void {
    if (this.active?.readyState === WebSocket.OPEN) {
      this.active.send(JSON.stringify(msg))
    }
  }

  disconnectClient(reason: string): void {
    if (!this.active) return
    this.send({ t: 'bye', reason })
    this.active.close(CLOSE_REJECTED, reason)
    this.active = null
  }

  async stop(): Promise<void> {
    this.active = null
    const wss = this.wss
    const http = this.http
    this.wss = null
    this.http = null
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()))
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()))
  }

  private handleConnection(ws: WebSocket): void {
    if (this.hasClient()) {
      ws.close(CLOSE_BUSY, 'another client is connected')
      return
    }

    const challenge = generateChallenge()
    let authed = false

    const authTimer = setTimeout(() => {
      if (!authed) ws.close(CLOSE_AUTH_FAILED, 'auth timeout')
    }, AUTH_TIMEOUT_MS)

    ws.on('message', (data) => {
      const msg = parseSignalMessage(parseJson(data.toString()))

      if (!authed) {
        if (!msg || msg.t !== 'auth') {
          ws.close(CLOSE_AUTH_FAILED, 'auth required')
          return
        }
        if (msg.version !== PROTOCOL_VERSION) {
          ws.close(CLOSE_BAD_VERSION, `host speaks v${PROTOCOL_VERSION}`)
          return
        }
        if (!verifyProof(this.opts.pin, challenge, msg.proof)) {
          ws.close(CLOSE_AUTH_FAILED, 'wrong pin')
          return
        }

        const finish = (approved: boolean): void => {
          if (!approved) {
            ws.close(CLOSE_REJECTED, 'rejected by host')
            return
          }
          authed = true
          clearTimeout(authTimer)
          this.active = ws
          ws.send(JSON.stringify({ t: 'auth-ok' } satisfies SignalMessage))
          this.opts.onClientAuthenticated(msg.clientName)
        }

        if (this.opts.approveClient) {
          void this.opts.approveClient(msg.clientName).then(finish, () => finish(false))
        } else {
          finish(true)
        }
        return
      }

      // Authenticated: silently drop anything we cannot parse.
      if (!msg) return
      if (msg.t === 'auth' || msg.t === 'auth-ok' || msg.t === 'challenge') return
      this.opts.onMessage(msg)
    })

    ws.on('close', () => {
      clearTimeout(authTimer)
      if (this.active === ws) {
        this.active = null
        this.opts.onClientGone()
      }
    })

    ws.on('error', () => ws.close())

    ws.send(
      JSON.stringify({
        t: 'challenge',
        challenge,
        hostName: this.opts.hostName,
        version: PROTOCOL_VERSION
      } satisfies SignalMessage)
    )
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/main/signaling.test.ts`
Expected: PASS — all 8 cases.

- [ ] **Step 5: Commit**

```bash
git add src/main/signaling-server.ts tests/main/signaling.test.ts
git commit -m "feat: host signaling server with pin auth and single-client relay"
```

---

### Task 5: Client-side signaling connector

**Files:**
- Create: `src/main/signaling-client.ts`
- Test: extend `tests/main/signaling.test.ts`

- [ ] **Step 1: Write the failing test (append to `tests/main/signaling.test.ts`)**

```ts
import { SignalingClient } from '../../src/main/signaling-client'

describe('SignalingClient', () => {
  it('completes the handshake against the real server', async () => {
    const { port, received } = await startServer({ pin: '222333' })
    const events: string[] = []
    const client = new SignalingClient({
      host: '127.0.0.1',
      port,
      pin: '222333',
      clientName: 'Laptop',
      onConnected: (hostName) => events.push(`connected:${hostName}`),
      onMessage: (msg) => events.push(`msg:${msg.t}`),
      onClosed: (code) => events.push(`closed:${code}`)
    })

    await client.connect()
    expect(events).toContain('connected:TestHost')

    client.send({ t: 'answer', sdp: 'v=0 from client' })
    await new Promise((r) => setTimeout(r, 100))
    expect(received).toEqual([{ t: 'answer', sdp: 'v=0 from client' }])

    await client.close()
  })

  it('rejects connect() when the pin is wrong', async () => {
    const { port } = await startServer({ pin: '222333' })
    const client = new SignalingClient({
      host: '127.0.0.1',
      port,
      pin: '000000',
      clientName: 'Laptop',
      onConnected: () => undefined,
      onMessage: () => undefined,
      onClosed: () => undefined
    })

    await expect(client.connect()).rejects.toThrow(/pin|auth/i)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/main/signaling.test.ts`
Expected: FAIL — cannot resolve `src/main/signaling-client`.

- [ ] **Step 3: Write `src/main/signaling-client.ts`**

```ts
import { WebSocket } from 'ws'
import { computeProof } from '../shared/auth'
import {
  AUTH_TIMEOUT_MS,
  PROTOCOL_VERSION,
  parseJson,
  parseSignalMessage,
  type SignalMessage
} from '../shared/protocol'
import { CLOSE_AUTH_FAILED, CLOSE_BAD_VERSION, CLOSE_BUSY, CLOSE_REJECTED } from './signaling-server'

export interface SignalingClientOptions {
  host: string
  port: number
  pin: string
  clientName: string
  onConnected: (hostName: string) => void
  onMessage: (msg: SignalMessage) => void
  onClosed: (code: number, reason: string) => void
}

function describeClose(code: number, reason: string): string {
  if (reason) return reason
  switch (code) {
    case CLOSE_AUTH_FAILED:
      return 'wrong pin or auth timeout'
    case CLOSE_BUSY:
      return 'the host already has a client connected'
    case CLOSE_BAD_VERSION:
      return 'app versions do not match — update both machines'
    case CLOSE_REJECTED:
      return 'the host rejected the session'
    default:
      return `connection closed (${code})`
  }
}

export class SignalingClient {
  private ws: WebSocket | null = null
  private authed = false

  constructor(private readonly opts: SignalingClientOptions) {}

  /** Resolves once auth-ok arrives; rejects with a human-readable reason otherwise. */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://${this.opts.host}:${this.opts.port}`)
      this.ws = ws

      const timer = setTimeout(() => {
        reject(new Error('timed out waiting for the host'))
        ws.close()
      }, AUTH_TIMEOUT_MS)

      ws.on('message', (data) => {
        const msg = parseSignalMessage(parseJson(data.toString()))
        if (!msg) return

        if (msg.t === 'challenge') {
          if (msg.version !== PROTOCOL_VERSION) {
            clearTimeout(timer)
            reject(new Error('app versions do not match — update both machines'))
            ws.close()
            return
          }
          ws.send(
            JSON.stringify({
              t: 'auth',
              proof: computeProof(this.opts.pin, msg.challenge),
              clientName: this.opts.clientName,
              version: PROTOCOL_VERSION
            } satisfies SignalMessage)
          )
          this.pendingHostName = msg.hostName
          return
        }

        if (msg.t === 'auth-ok') {
          clearTimeout(timer)
          this.authed = true
          this.opts.onConnected(this.pendingHostName)
          resolve()
          return
        }

        if (this.authed) this.opts.onMessage(msg)
      })

      ws.on('error', (err) => {
        clearTimeout(timer)
        if (!this.authed) reject(err instanceof Error ? err : new Error(String(err)))
      })

      ws.on('close', (code, reasonBuf) => {
        clearTimeout(timer)
        const reason = describeClose(code, reasonBuf.toString())
        if (!this.authed) reject(new Error(reason))
        else this.opts.onClosed(code, reason)
        this.ws = null
      })
    })
  }

  private pendingHostName = 'host'

  send(msg: SignalMessage): void {
    if (this.authed && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  async close(): Promise<void> {
    const ws = this.ws
    this.ws = null
    this.authed = false
    if (!ws) return
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve())
      ws.close()
      setTimeout(resolve, 500)
    })
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/main/signaling.test.ts`
Expected: PASS — 10 cases total.

- [ ] **Step 5: Commit**

```bash
git add src/main/signaling-client.ts tests/main/signaling.test.ts
git commit -m "feat: client signaling connector with readable failure reasons"
```

---

### Task 6: LAN host discovery over UDP

So the client shows "Keith's MacBook" instead of asking for an IP address. The client broadcasts a one-word query; hosts answer by unicast.

**Files:**
- Create: `src/main/discovery.ts`
- Test: `tests/main/discovery.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { DiscoveryResponder, queryHosts } from '../../src/main/discovery'

let responder: DiscoveryResponder | null = null

afterEach(async () => {
  await responder?.stop()
  responder = null
})

describe('discovery', () => {
  it('answers a query with the host beacon', async () => {
    const port = 45899
    responder = new DiscoveryResponder({
      port,
      beacon: () => ({ hostName: 'TestHost', port: 45789, platform: 'darwin' })
    })
    await responder.start()

    const hosts = await queryHosts({ port, timeoutMs: 600, broadcastAddress: '127.0.0.1' })

    expect(hosts).toHaveLength(1)
    expect(hosts[0]).toMatchObject({
      hostName: 'TestHost',
      port: 45789,
      platform: 'darwin',
      address: '127.0.0.1'
    })
  })

  it('returns an empty list when nothing is listening', async () => {
    const hosts = await queryHosts({ port: 45898, timeoutMs: 400, broadcastAddress: '127.0.0.1' })
    expect(hosts).toEqual([])
  })

  it('ignores traffic that is not our protocol', async () => {
    const port = 45897
    responder = new DiscoveryResponder({
      port,
      beacon: () => ({ hostName: 'TestHost', port: 45789, platform: 'darwin' })
    })
    await responder.start()

    const { createSocket } = await import('node:dgram')
    const sock = createSocket('udp4')
    const replies: string[] = []
    sock.on('message', (buf) => replies.push(buf.toString()))
    await new Promise<void>((resolve) => sock.bind(0, '127.0.0.1', () => resolve()))
    sock.send('hello?', port, '127.0.0.1')
    await new Promise((r) => setTimeout(r, 400))
    sock.close()

    expect(replies).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/main/discovery.test.ts`
Expected: FAIL — cannot resolve `src/main/discovery`.

- [ ] **Step 3: Write `src/main/discovery.ts`**

```ts
import { createSocket, type Socket } from 'node:dgram'
import { DISCOVERY_MAGIC, DISCOVERY_PORT, PROTOCOL_VERSION, parseJson } from '../shared/protocol'

export interface HostBeacon {
  hostName: string
  port: number
  platform: string
}

export interface DiscoveredHost extends HostBeacon {
  address: string
}

interface BeaconWire extends HostBeacon {
  magic: string
  version: number
}

/** Runs on the host: replies to discovery queries while sharing is enabled. */
export class DiscoveryResponder {
  private socket: Socket | null = null

  constructor(private readonly opts: { port?: number; beacon: () => HostBeacon }) {}

  async start(): Promise<void> {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    socket.on('message', (buf, rinfo) => {
      if (buf.toString() !== DISCOVERY_MAGIC) return
      const beacon = this.opts.beacon()
      const wire: BeaconWire = { magic: DISCOVERY_MAGIC, version: PROTOCOL_VERSION, ...beacon }
      socket.send(JSON.stringify(wire), rinfo.port, rinfo.address)
    })
    socket.on('error', () => this.stop())

    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(this.opts.port ?? DISCOVERY_PORT, () => resolve())
    })
    this.socket = socket
  }

  async stop(): Promise<void> {
    const socket = this.socket
    this.socket = null
    if (!socket) return
    await new Promise<void>((resolve) => socket.close(() => resolve()))
  }
}

/** Runs on the client: broadcasts one query and collects replies until the timeout. */
export function queryHosts(
  opts: { port?: number; timeoutMs?: number; broadcastAddress?: string } = {}
): Promise<DiscoveredHost[]> {
  const port = opts.port ?? DISCOVERY_PORT
  const timeoutMs = opts.timeoutMs ?? 1200
  const broadcastAddress = opts.broadcastAddress ?? '255.255.255.255'

  return new Promise((resolve) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    const found = new Map<string, DiscoveredHost>()

    socket.on('message', (buf, rinfo) => {
      const wire = parseJson(buf.toString()) as Partial<BeaconWire> | null
      if (!wire || wire.magic !== DISCOVERY_MAGIC || wire.version !== PROTOCOL_VERSION) return
      if (typeof wire.hostName !== 'string' || typeof wire.port !== 'number') return
      found.set(`${rinfo.address}:${wire.port}`, {
        address: rinfo.address,
        hostName: wire.hostName,
        port: wire.port,
        platform: typeof wire.platform === 'string' ? wire.platform : 'unknown'
      })
    })

    socket.on('error', () => {
      socket.close()
      resolve([])
    })

    socket.bind(0, () => {
      socket.setBroadcast(true)
      socket.send(DISCOVERY_MAGIC, port, broadcastAddress)
      setTimeout(() => {
        socket.close()
        resolve([...found.values()])
      }, timeoutMs)
    })
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/main/discovery.test.ts`
Expected: PASS — 3 cases. (macOS may prompt once to allow incoming network connections for `node`; allow it.)

- [ ] **Step 5: Commit**

```bash
git add src/main/discovery.ts tests/main/discovery.test.ts
git commit -m "feat: UDP query/reply LAN host discovery"
```

---

### Task 7: Screen capture plumbing in main

**Files:**
- Create: `src/main/capture.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Write `src/main/capture.ts`**

```ts
import { desktopCapturer, session } from 'electron'

export interface ScreenChoice {
  id: string
  name: string
  thumbnailDataUrl: string
}

let selectedSourceId: string | null = null

export async function listScreens(): Promise<ScreenChoice[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 200 }
  })
  return sources.map((s) => ({
    id: s.id,
    name: s.name || 'Screen',
    thumbnailDataUrl: s.thumbnail.toDataURL()
  }))
}

export function setSelectedScreen(id: string | null): void {
  selectedSourceId = id
}

export function getSelectedScreen(): string | null {
  return selectedSourceId
}

/**
 * Electron routes getDisplayMedia() through main for consent. We answer with the
 * screen the user picked in the host UI, so the renderer never needs a picker.
 */
export function registerDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        const chosen = sources.find((s) => s.id === selectedSourceId) ?? sources[0]
        if (!chosen) {
          // An empty response denies the request.
          callback({})
          return
        }
        callback({ video: chosen })
      })
    },
    { useSystemPicker: false }
  )
}
```

- [ ] **Step 2: Call the handler registration from `src/main/index.ts`**

Add the import next to the existing imports:

```ts
import { registerDisplayMediaHandler } from './capture'
```

and change the `app.whenReady()` block to:

```ts
app.whenReady().then(() => {
  registerDisplayMediaHandler()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/capture.ts src/main/index.ts
git commit -m "feat: screen source listing and display-media consent handler"
```

---

### Task 8: IPC surface and preload bridge

One file owns every `ipcMain` handler, one file owns everything the renderer may call. No `ipcRenderer` leaks into the renderer.

**Files:**
- Create: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Create: `src/renderer/rd.d.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Write `src/main/ipc.ts`**

```ts
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
```

- [ ] **Step 2: Replace `src/preload/index.ts`**

```ts
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
```

- [ ] **Step 3: Write `src/renderer/rd.d.ts`**

```ts
import type { RdApi } from '../preload/index'

declare global {
  interface Window {
    rd: RdApi
  }
}
```

- [ ] **Step 4: Call `registerIpc()` from `src/main/index.ts`**

Add to the imports:

```ts
import { registerIpc } from './ipc'
```

and inside `app.whenReady().then(...)`, before `createWindow()`:

```ts
  registerIpc()
```

- [ ] **Step 5: Verify typecheck and that the app still boots**

```bash
npm run typecheck && npm run dev
```
Expected: typecheck clean; window opens; DevTools console shows no errors. Close the app.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc.ts src/main/index.ts src/preload/index.ts src/renderer/rd.d.ts
git commit -m "feat: ipc surface and contextBridge api for host/client roles"
```

---

### Task 9: WebRTC peer helper + host/client sessions (view-only)

End of M1: the client sees the host's screen.

**Files:**
- Create: `src/renderer/rtc/peer.ts`
- Create: `src/renderer/rtc/host-session.ts`
- Create: `src/renderer/rtc/client-session.ts`

- [ ] **Step 1: Write `src/renderer/rtc/peer.ts`**

```ts
import type { IceCandidatePayload } from '../../shared/protocol'

export interface PeerHandles {
  pc: RTCPeerConnection
  /** Set by the host (it creates the channels); filled on the client via ondatachannel. */
  channels: { input?: RTCDataChannel; ctrl?: RTCDataChannel; file?: RTCDataChannel }
}

export function createPeer(onIce: (candidate: IceCandidatePayload) => void): PeerHandles {
  // No STUN/TURN: LAN only in this plan. The internet plan adds ice servers here.
  const pc = new RTCPeerConnection({ iceServers: [] })
  const handles: PeerHandles = { pc, channels: {} }

  pc.onicecandidate = (event) => {
    if (!event.candidate) return
    onIce({
      candidate: event.candidate.candidate,
      sdpMid: event.candidate.sdpMid,
      sdpMLineIndex: event.candidate.sdpMLineIndex,
      usernameFragment: event.candidate.usernameFragment
    })
  }

  return handles
}

export function addIceCandidate(pc: RTCPeerConnection, payload: IceCandidatePayload): void {
  void pc.addIceCandidate({
    candidate: payload.candidate,
    sdpMid: payload.sdpMid ?? undefined,
    sdpMLineIndex: payload.sdpMLineIndex ?? undefined,
    usernameFragment: payload.usernameFragment ?? undefined
  })
}

/** Cap the screen stream so a busy desktop cannot saturate the link. */
export async function limitBitrate(sender: RTCRtpSender, maxBitrate: number): Promise<void> {
  const params = sender.getParameters()
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
  params.encodings[0]!.maxBitrate = maxBitrate
  await sender.setParameters(params)
}
```

- [ ] **Step 2: Write `src/renderer/rtc/host-session.ts`**

```ts
import { parseSignalMessage, type SignalMessage } from '../../shared/protocol'
import { addIceCandidate, createPeer, limitBitrate, type PeerHandles } from './peer'

export interface HostSessionCallbacks {
  onStatus: (text: string) => void
  onInputMessage: (raw: string) => void
  onCtrlMessage: (raw: string) => void
  onFileChunk: (chunk: ArrayBuffer) => void
}

const MAX_SCREEN_BITRATE = 8_000_000

export class HostSession {
  private peer: PeerHandles | null = null
  private stream: MediaStream | null = null

  constructor(private readonly cb: HostSessionCallbacks) {}

  /** Called once a client has authenticated: capture the screen and offer it. */
  async start(): Promise<void> {
    this.stop()

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false
    })
    this.stream = stream
    const track = stream.getVideoTracks()[0]
    if (!track) throw new Error('no video track from getDisplayMedia')
    // 'detail' tells the encoder to favour text sharpness over motion smoothness.
    track.contentHint = 'detail'

    const peer = createPeer((candidate) => void window.rd.host.signal({ t: 'ice', candidate }))
    this.peer = peer

    peer.channels.input = peer.pc.createDataChannel('input', { ordered: true })
    peer.channels.ctrl = peer.pc.createDataChannel('ctrl', { ordered: true })
    peer.channels.file = peer.pc.createDataChannel('file', { ordered: true })
    peer.channels.file.binaryType = 'arraybuffer'

    peer.channels.input.onmessage = (e) => this.cb.onInputMessage(String(e.data))
    peer.channels.ctrl.onmessage = (e) => this.cb.onCtrlMessage(String(e.data))
    peer.channels.file.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) this.cb.onFileChunk(e.data)
    }

    const sender = peer.pc.addTrack(track, stream)
    await limitBitrate(sender, MAX_SCREEN_BITRATE)

    peer.pc.onconnectionstatechange = () =>
      this.cb.onStatus(`peer: ${peer.pc.connectionState}`)

    const offer = await peer.pc.createOffer()
    await peer.pc.setLocalDescription(offer)
    await window.rd.host.signal({ t: 'offer', sdp: offer.sdp ?? '' })
    this.cb.onStatus('offer sent')
  }

  async handleSignal(raw: unknown): Promise<void> {
    const msg = parseSignalMessage(raw)
    if (!msg || !this.peer) return
    if (msg.t === 'answer') {
      await this.peer.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
      this.cb.onStatus('answer applied')
    } else if (msg.t === 'ice') {
      addIceCandidate(this.peer.pc, msg.candidate)
    }
  }

  send(channel: 'ctrl' | 'file', data: string | ArrayBuffer): void {
    const ch = this.peer?.channels[channel]
    if (ch?.readyState !== 'open') return
    if (typeof data === 'string') ch.send(data)
    else ch.send(data)
  }

  channel(name: 'ctrl' | 'file' | 'input'): RTCDataChannel | undefined {
    return this.peer?.channels[name]
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.peer?.pc.close()
    this.peer = null
  }
}

export type { SignalMessage }
```

- [ ] **Step 3: Write `src/renderer/rtc/client-session.ts`**

```ts
import { parseSignalMessage } from '../../shared/protocol'
import { addIceCandidate, createPeer, type PeerHandles } from './peer'

export interface ClientSessionCallbacks {
  onStatus: (text: string) => void
  onStream: (stream: MediaStream) => void
  onCtrlMessage: (raw: string) => void
  onFileChunk: (chunk: ArrayBuffer) => void
}

export class ClientSession {
  private peer: PeerHandles | null = null

  constructor(private readonly cb: ClientSessionCallbacks) {}

  async handleSignal(raw: unknown): Promise<void> {
    const msg = parseSignalMessage(raw)
    if (!msg) return

    if (msg.t === 'offer') {
      this.stop()
      const peer = createPeer((candidate) => void window.rd.client.signal({ t: 'ice', candidate }))
      this.peer = peer

      peer.pc.ontrack = (event) => {
        const stream = event.streams[0]
        if (stream) this.cb.onStream(stream)
      }

      peer.pc.ondatachannel = (event) => {
        const ch = event.channel
        if (ch.label === 'input') peer.channels.input = ch
        if (ch.label === 'ctrl') {
          peer.channels.ctrl = ch
          ch.onmessage = (e) => this.cb.onCtrlMessage(String(e.data))
        }
        if (ch.label === 'file') {
          peer.channels.file = ch
          ch.binaryType = 'arraybuffer'
          ch.onmessage = (e) => {
            if (e.data instanceof ArrayBuffer) this.cb.onFileChunk(e.data)
          }
        }
      }

      peer.pc.onconnectionstatechange = () => this.cb.onStatus(`peer: ${peer.pc.connectionState}`)

      await peer.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp })
      const answer = await peer.pc.createAnswer()
      await peer.pc.setLocalDescription(answer)
      await window.rd.client.signal({ t: 'answer', sdp: answer.sdp ?? '' })
      this.cb.onStatus('answer sent')
      return
    }

    if (msg.t === 'ice' && this.peer) addIceCandidate(this.peer.pc, msg.candidate)
  }

  channel(name: 'input' | 'ctrl' | 'file'): RTCDataChannel | undefined {
    return this.peer?.channels[name]
  }

  stop(): void {
    this.peer?.pc.close()
    this.peer = null
  }
}
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/rtc
git commit -m "feat: webrtc peer helper with host offer and client answer sessions"
```

---

### Task 10: Host and client UI — first end-to-end screen view

**Files:**
- Create: `src/renderer/ui/host-view.ts`
- Create: `src/renderer/ui/client-view.ts`
- Create: `src/renderer/ui/remote-screen.ts`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: Write `src/renderer/ui/remote-screen.ts`**

```ts
/** Owns the <video> that shows the remote desktop. Input capture is added in Task 13. */
export class RemoteScreen {
  readonly el: HTMLDivElement
  readonly video: HTMLVideoElement

  constructor() {
    this.el = document.createElement('div')
    this.el.className = 'remote-screen'
    this.video = document.createElement('video')
    this.video.autoplay = true
    this.video.playsInline = true
    this.video.muted = true
    this.el.append(this.video)
  }

  setStream(stream: MediaStream): void {
    this.video.srcObject = stream
  }

  clear(): void {
    this.video.srcObject = null
  }
}
```

- [ ] **Step 2: Write `src/renderer/ui/host-view.ts`**

```ts
import { HostSession } from '../rtc/host-session'

interface ScreenChoice {
  id: string
  name: string
  thumbnailDataUrl: string
}

export function createHostView(): HTMLElement {
  const root = document.createElement('section')
  root.className = 'pane'
  root.innerHTML = `
    <h2>Share this machine</h2>
    <label>Screen <select id="host-screen"></select></label>
    <div class="row">
      <button id="host-start">Start sharing</button>
      <button id="host-stop" disabled>Stop</button>
    </div>
    <p class="pin">PIN: <strong id="host-pin">------</strong></p>
    <p class="status" id="host-status">idle</p>
  `

  const select = root.querySelector<HTMLSelectElement>('#host-screen')!
  const startBtn = root.querySelector<HTMLButtonElement>('#host-start')!
  const stopBtn = root.querySelector<HTMLButtonElement>('#host-stop')!
  const pinEl = root.querySelector<HTMLElement>('#host-pin')!
  const statusEl = root.querySelector<HTMLElement>('#host-status')!

  const setStatus = (text: string): void => {
    statusEl.textContent = text
  }

  const session = new HostSession({
    onStatus: setStatus,
    onInputMessage: () => undefined, // wired in Task 13
    onCtrlMessage: () => undefined, // wired in Task 16
    onFileChunk: () => undefined // wired in Task 15
  })

  void window.rd.screens.list().then((screens: ScreenChoice[]) => {
    select.innerHTML = screens
      .map((s) => `<option value="${s.id}">${s.name}</option>`)
      .join('')
    if (screens[0]) void window.rd.screens.select(screens[0].id)
  })

  select.onchange = () => void window.rd.screens.select(select.value)

  startBtn.onclick = async () => {
    startBtn.disabled = true
    try {
      const { pin, port } = (await window.rd.host.start()) as { pin: string; port: number }
      pinEl.textContent = pin
      setStatus(`listening on port ${port} — waiting for a client`)
      stopBtn.disabled = false
    } catch (err) {
      setStatus(`failed to start: ${(err as Error).message}`)
      startBtn.disabled = false
    }
  }

  stopBtn.onclick = async () => {
    session.stop()
    await window.rd.host.stop()
    pinEl.textContent = '------'
    setStatus('idle')
    stopBtn.disabled = true
    startBtn.disabled = false
  }

  window.rd.host.onClientJoined(async (payload) => {
    const { clientName } = payload as { clientName: string }
    setStatus(`${clientName} connected — capturing screen`)
    try {
      await session.start()
    } catch (err) {
      setStatus(`capture failed: ${(err as Error).message}`)
    }
  })

  window.rd.host.onClientLeft(() => {
    session.stop()
    setStatus('client left — waiting')
  })

  window.rd.host.onSignal((msg) => void session.handleSignal(msg))

  return root
}
```

- [ ] **Step 3: Write `src/renderer/ui/client-view.ts`**

```ts
import { ClientSession } from '../rtc/client-session'
import { RemoteScreen } from './remote-screen'

interface DiscoveredHost {
  address: string
  hostName: string
  port: number
  platform: string
}

export function createClientView(): HTMLElement {
  const root = document.createElement('section')
  root.className = 'pane'
  root.innerHTML = `
    <h2>Control another machine</h2>
    <div class="row">
      <button id="cl-scan">Scan LAN</button>
      <select id="cl-hosts"><option value="">— no hosts found —</option></select>
    </div>
    <div class="row">
      <input id="cl-address" placeholder="192.168.1.20" />
      <input id="cl-port" value="45789" size="6" />
      <input id="cl-pin" placeholder="PIN" maxlength="6" size="8" />
      <button id="cl-connect">Connect</button>
      <button id="cl-disconnect" disabled>Disconnect</button>
    </div>
    <p class="status" id="cl-status">idle</p>
  `

  const scanBtn = root.querySelector<HTMLButtonElement>('#cl-scan')!
  const hostsSel = root.querySelector<HTMLSelectElement>('#cl-hosts')!
  const addressInput = root.querySelector<HTMLInputElement>('#cl-address')!
  const portInput = root.querySelector<HTMLInputElement>('#cl-port')!
  const pinInput = root.querySelector<HTMLInputElement>('#cl-pin')!
  const connectBtn = root.querySelector<HTMLButtonElement>('#cl-connect')!
  const disconnectBtn = root.querySelector<HTMLButtonElement>('#cl-disconnect')!
  const statusEl = root.querySelector<HTMLElement>('#cl-status')!

  const screen = new RemoteScreen()
  root.append(screen.el)

  const setStatus = (text: string): void => {
    statusEl.textContent = text
  }

  const session = new ClientSession({
    onStatus: setStatus,
    onStream: (stream) => screen.setStream(stream),
    onCtrlMessage: () => undefined, // wired in Task 16
    onFileChunk: () => undefined // wired in Task 15
  })

  scanBtn.onclick = async () => {
    setStatus('scanning…')
    const hosts = (await window.rd.client.discover()) as DiscoveredHost[]
    hostsSel.innerHTML = hosts.length
      ? hosts
          .map(
            (h) =>
              `<option value="${h.address}:${h.port}">${h.hostName} (${h.address}) — ${h.platform}</option>`
          )
          .join('')
      : '<option value="">— no hosts found —</option>'
    setStatus(`${hosts.length} host(s) found`)
  }

  hostsSel.onchange = () => {
    const [address, port] = hostsSel.value.split(':')
    if (address) addressInput.value = address
    if (port) portInput.value = port
  }

  connectBtn.onclick = async () => {
    connectBtn.disabled = true
    setStatus('connecting…')
    try {
      await window.rd.client.connect({
        address: addressInput.value.trim(),
        port: Number(portInput.value),
        pin: pinInput.value.trim()
      })
      disconnectBtn.disabled = false
    } catch (err) {
      setStatus(`connect failed: ${(err as Error).message}`)
      connectBtn.disabled = false
    }
  }

  disconnectBtn.onclick = async () => {
    session.stop()
    screen.clear()
    await window.rd.client.disconnect()
    setStatus('idle')
    disconnectBtn.disabled = true
    connectBtn.disabled = false
  }

  window.rd.client.onConnected((payload) => {
    const { hostName } = payload as { hostName: string }
    setStatus(`connected to ${hostName} — waiting for screen`)
  })

  window.rd.client.onClosed((payload) => {
    const { reason } = payload as { reason: string }
    session.stop()
    screen.clear()
    setStatus(`disconnected: ${reason}`)
    disconnectBtn.disabled = true
    connectBtn.disabled = false
  })

  window.rd.client.onSignal((msg) => void session.handleSignal(msg))

  return root
}
```

- [ ] **Step 4: Replace `src/renderer/main.ts`**

```ts
import './styles.css'
import { createClientView } from './ui/client-view'
import { createHostView } from './ui/host-view'

type Role = 'host' | 'client'

const app = document.querySelector<HTMLDivElement>('#app')!
let current: HTMLElement | null = null

function render(role: Role): void {
  current?.remove()
  current = role === 'host' ? createHostView() : createClientView()
  app.append(current)
}

const tabs = document.createElement('nav')
tabs.className = 'tabs'
tabs.innerHTML = `
  <button data-role="client" class="active">Control a machine</button>
  <button data-role="host">Share this machine</button>
  <span id="who"></span>
`
app.append(tabs)

tabs.addEventListener('click', (event) => {
  const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-role]')
  if (!btn) return
  tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn))
  render(btn.dataset.role as Role)
})

void window.rd.identity().then((id) => {
  const who = tabs.querySelector<HTMLElement>('#who')
  if (who) {
    const { machineName, platform } = id as { machineName: string; platform: string }
    who.textContent = `${machineName} · ${platform}`
  }
})

render('client')
```

- [ ] **Step 5: Append to `src/renderer/styles.css`**

```css
.tabs { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; }
.tabs #who { margin-left: auto; opacity: 0.6; font-size: 12px; }
.tabs button.active { font-weight: 600; }
.pane { display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.status { font-size: 13px; opacity: 0.75; margin: 0; }
.pin strong { font-size: 24px; letter-spacing: 4px; font-variant-numeric: tabular-nums; }
.remote-screen { background: #000; border-radius: 6px; overflow: hidden; }
.remote-screen video { display: block; width: 100%; height: auto; }
```

- [ ] **Step 6: Manual verification — the M1 acceptance test**

This needs two machines (or one Mac plus a second device) on the same Wi-Fi.

1. On machine A (host): `npm run dev` → *Share this machine* → *Start sharing*. Note the PIN.
   - On macOS the first run triggers the **Screen Recording** prompt. Grant it, then quit and rerun `npm run dev` (macOS requires a relaunch after granting).
2. On machine B (client): `npm run dev` → *Control a machine* → *Scan LAN* → pick machine A → type the PIN → *Connect*.
3. Expected: within a few seconds the black box fills with machine A's live screen; both status lines read `peer: connected`.

Troubleshooting:
- "no hosts found" → the firewall blocked UDP 45790, or the two devices are on different subnets/VLANs (common on guest Wi-Fi). Type the IP manually to bypass discovery.
- connect fails with "wrong pin" → the host restarted and rotated the PIN; read the new one.
- video stays black on macOS → Screen Recording not granted, or the app was not relaunched after granting.

- [ ] **Step 7: Commit**

```bash
git add src/renderer
git commit -m "feat(M1): LAN discovery, pin connect and live remote screen view"
```

---
# M2 — Mouse and keyboard control

### Task 11: Coordinate mapping

The single most common cause of "the cursor is offset" bugs. Solved once, here, with tests.

**Files:**
- Create: `src/shared/coords.ts`
- Test: `tests/shared/coords.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import {
  elementPointToNormalized,
  normalizedToScreenPixels,
  wheelDeltaToTicks
} from '../../src/shared/coords'

describe('elementPointToNormalized', () => {
  it('maps the centre of a same-size element to (0.5, 0.5)', () => {
    expect(
      elementPointToNormalized({ x: 800, y: 450 }, { width: 1600, height: 900 }, { width: 1600, height: 900 })
    ).toEqual({ x: 0.5, y: 0.5 })
  })

  it('maps correctly when the element is a scaled-down copy', () => {
    expect(
      elementPointToNormalized({ x: 400, y: 225 }, { width: 800, height: 450 }, { width: 1600, height: 900 })
    ).toEqual({ x: 0.5, y: 0.5 })
  })

  it('accounts for horizontal letterboxing (wide video in a square box)', () => {
    // 1000x500 video inside a 1000x1000 box => 250px bars top and bottom.
    const element = { width: 1000, height: 1000 }
    const intrinsic = { width: 1000, height: 500 }
    expect(elementPointToNormalized({ x: 500, y: 500 }, element, intrinsic)).toEqual({ x: 0.5, y: 0.5 })
    expect(elementPointToNormalized({ x: 0, y: 250 }, element, intrinsic)).toEqual({ x: 0, y: 0 })
    expect(elementPointToNormalized({ x: 1000, y: 750 }, element, intrinsic)).toEqual({ x: 1, y: 1 })
  })

  it('returns null for a point inside the letterbox bar', () => {
    expect(
      elementPointToNormalized({ x: 500, y: 100 }, { width: 1000, height: 1000 }, { width: 1000, height: 500 })
    ).toBeNull()
    expect(
      elementPointToNormalized({ x: 500, y: 900 }, { width: 1000, height: 1000 }, { width: 1000, height: 500 })
    ).toBeNull()
  })

  it('accounts for vertical pillarboxing (tall video in a square box)', () => {
    const element = { width: 1000, height: 1000 }
    const intrinsic = { width: 500, height: 1000 }
    expect(elementPointToNormalized({ x: 250, y: 0 }, element, intrinsic)).toEqual({ x: 0, y: 0 })
    expect(elementPointToNormalized({ x: 100, y: 500 }, element, intrinsic)).toBeNull()
  })

  it('returns null when either size is degenerate', () => {
    expect(
      elementPointToNormalized({ x: 1, y: 1 }, { width: 0, height: 100 }, { width: 10, height: 10 })
    ).toBeNull()
    expect(
      elementPointToNormalized({ x: 1, y: 1 }, { width: 100, height: 100 }, { width: 0, height: 10 })
    ).toBeNull()
  })
})

describe('normalizedToScreenPixels', () => {
  it('maps the centre to the middle pixel', () => {
    expect(normalizedToScreenPixels({ x: 0.5, y: 0.5 }, { width: 1920, height: 1080 })).toEqual({
      x: 960,
      y: 540
    })
  })

  it('never returns a coordinate outside the screen', () => {
    expect(normalizedToScreenPixels({ x: 1, y: 1 }, { width: 1920, height: 1080 })).toEqual({
      x: 1919,
      y: 1079
    })
    expect(normalizedToScreenPixels({ x: 0, y: 0 }, { width: 1920, height: 1080 })).toEqual({
      x: 0,
      y: 0
    })
  })

  it('clamps hostile out-of-range input', () => {
    expect(normalizedToScreenPixels({ x: 5, y: -5 }, { width: 1920, height: 1080 })).toEqual({
      x: 1919,
      y: 0
    })
  })
})

describe('wheelDeltaToTicks', () => {
  it('converts pixel deltas into scroll ticks', () => {
    expect(wheelDeltaToTicks(0)).toBe(0)
    expect(wheelDeltaToTicks(100)).toBe(1)
    expect(wheelDeltaToTicks(120)).toBe(1)
    expect(wheelDeltaToTicks(250)).toBe(3)
    expect(wheelDeltaToTicks(-120)).toBe(-1)
  })

  it('still scrolls one tick for a tiny trackpad delta', () => {
    expect(wheelDeltaToTicks(5)).toBe(1)
    expect(wheelDeltaToTicks(-5)).toBe(-1)
  })

  it('caps a huge delta and ignores garbage', () => {
    expect(wheelDeltaToTicks(50_000)).toBe(10)
    expect(wheelDeltaToTicks(Number.NaN)).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/shared/coords.test.ts`
Expected: FAIL — cannot resolve `src/shared/coords`.

- [ ] **Step 3: Write `src/shared/coords.ts`**

```ts
export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

const MAX_SCROLL_TICKS = 10
const PIXELS_PER_TICK = 100

/**
 * Convert a pointer position inside the <video> element into a 0..1 position on
 * the remote screen, undoing the `object-fit: contain` letterboxing.
 * Returns null when the point is in a black bar (nothing to click there).
 */
export function elementPointToNormalized(
  point: Point,
  element: Size,
  intrinsic: Size
): Point | null {
  if (element.width <= 0 || element.height <= 0) return null
  if (intrinsic.width <= 0 || intrinsic.height <= 0) return null

  const scale = Math.min(element.width / intrinsic.width, element.height / intrinsic.height)
  const displayedWidth = intrinsic.width * scale
  const displayedHeight = intrinsic.height * scale
  const offsetX = (element.width - displayedWidth) / 2
  const offsetY = (element.height - displayedHeight) / 2

  const x = (point.x - offsetX) / displayedWidth
  const y = (point.y - offsetY) / displayedHeight

  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (x < 0 || x > 1 || y < 0 || y > 1) return null
  return { x, y }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** Host side: turn a normalized position into an absolute pixel on this screen. */
export function normalizedToScreenPixels(normalized: Point, screen: Size): Point {
  return {
    x: Math.round(clamp(normalized.x, 0, 1) * (screen.width - 1)),
    y: Math.round(clamp(normalized.y, 0, 1) * (screen.height - 1))
  }
}

/** Browser wheel deltas are pixels; nut.js scrolls in ticks. */
export function wheelDeltaToTicks(delta: number): number {
  if (!Number.isFinite(delta) || delta === 0) return 0
  const raw = Math.round(Math.abs(delta) / PIXELS_PER_TICK)
  const magnitude = Math.min(Math.max(1, raw), MAX_SCROLL_TICKS)
  return delta > 0 ? magnitude : -magnitude
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/shared/coords.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/coords.ts tests/shared/coords.test.ts
git commit -m "feat: letterbox-aware coordinate mapping and wheel tick conversion"
```

---

### Task 12: Keyboard mapping, validated against the real nut.js enum

The second test in this task is the important one: it proves every name in the table is a real nut.js `Key` member, so a typo fails in CI instead of silently dropping a keystroke.

**Files:**
- Create: `src/shared/keymap.ts`
- Test: `tests/shared/keymap.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { Key } from '@nut-tree-fork/nut-js'
import { mapKeyCode, mappedKeyNames } from '../../src/shared/keymap'

describe('mapKeyCode', () => {
  it('maps letters, digits and function keys', () => {
    expect(mapKeyCode('KeyA')).toBe('A')
    expect(mapKeyCode('KeyZ')).toBe('Z')
    expect(mapKeyCode('Digit0')).toBe('Num0')
    expect(mapKeyCode('Digit9')).toBe('Num9')
    expect(mapKeyCode('F1')).toBe('F1')
    expect(mapKeyCode('F12')).toBe('F12')
  })

  it('maps modifiers to their sided nut.js names', () => {
    expect(mapKeyCode('ShiftLeft')).toBe('LeftShift')
    expect(mapKeyCode('ShiftRight')).toBe('RightShift')
    expect(mapKeyCode('ControlLeft')).toBe('LeftControl')
    expect(mapKeyCode('AltLeft')).toBe('LeftAlt')
    expect(mapKeyCode('MetaLeft')).toBe('LeftSuper')
    expect(mapKeyCode('MetaRight')).toBe('RightSuper')
  })

  it('distinguishes Return from the numpad Enter', () => {
    expect(mapKeyCode('Enter')).toBe('Return')
    expect(mapKeyCode('NumpadEnter')).toBe('Enter')
  })

  it('maps navigation, punctuation and numpad keys', () => {
    expect(mapKeyCode('ArrowUp')).toBe('Up')
    expect(mapKeyCode('Backspace')).toBe('Backspace')
    expect(mapKeyCode('Backquote')).toBe('Grave')
    expect(mapKeyCode('BracketLeft')).toBe('LeftBracket')
    expect(mapKeyCode('Numpad5')).toBe('NumPad5')
    expect(mapKeyCode('NumpadAdd')).toBe('Add')
  })

  it('returns null for unmapped or hostile codes', () => {
    expect(mapKeyCode('Fn')).toBeNull()
    expect(mapKeyCode('')).toBeNull()
    expect(mapKeyCode('__proto__')).toBeNull()
    expect(mapKeyCode('constructor')).toBeNull()
  })
})

describe('mapping integrity', () => {
  it('every mapped name exists in the real nut.js Key enum', () => {
    const keyNames = new Set(Object.keys(Key))
    const missing = mappedKeyNames().filter((name) => !keyNames.has(name))
    expect(missing).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/shared/keymap.test.ts`
Expected: FAIL — cannot resolve `src/shared/keymap`.

- [ ] **Step 3: Write `src/shared/keymap.ts`**

```ts
/**
 * Maps a browser `KeyboardEvent.code` (physical key identity) to the *name* of a
 * nut.js `Key` enum member. Returning a name instead of the enum value keeps this
 * module free of the native nut.js import, so it can run anywhere.
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function buildTable(): Record<string, string> {
  const table: Record<string, string> = {
    // modifiers
    ShiftLeft: 'LeftShift',
    ShiftRight: 'RightShift',
    ControlLeft: 'LeftControl',
    ControlRight: 'RightControl',
    AltLeft: 'LeftAlt',
    AltRight: 'RightAlt',
    MetaLeft: 'LeftSuper',
    MetaRight: 'RightSuper',
    CapsLock: 'CapsLock',

    // editing / navigation
    Enter: 'Return',
    NumpadEnter: 'Enter',
    Escape: 'Escape',
    Space: 'Space',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',

    // punctuation
    Backquote: 'Grave',
    Minus: 'Minus',
    Equal: 'Equal',
    BracketLeft: 'LeftBracket',
    BracketRight: 'RightBracket',
    Backslash: 'Backslash',
    Semicolon: 'Semicolon',
    Quote: 'Quote',
    Comma: 'Comma',
    Period: 'Period',
    Slash: 'Slash',

    // numpad operators
    NumpadAdd: 'Add',
    NumpadSubtract: 'Subtract',
    NumpadMultiply: 'Multiply',
    NumpadDivide: 'Divide',
    NumpadDecimal: 'Decimal',

    // system
    PrintScreen: 'Print',
    ScrollLock: 'ScrollLock',
    Pause: 'Pause',
    NumLock: 'NumLock',
    AudioVolumeMute: 'AudioMute',
    AudioVolumeDown: 'AudioVolDown',
    AudioVolumeUp: 'AudioVolUp'
  }

  for (const letter of LETTERS) table[`Key${letter}`] = letter
  for (let i = 0; i <= 9; i++) {
    table[`Digit${i}`] = `Num${i}`
    table[`Numpad${i}`] = `NumPad${i}`
  }
  for (let i = 1; i <= 12; i++) table[`F${i}`] = `F${i}`

  return table
}

const TABLE = buildTable()

export function mapKeyCode(code: string): string | null {
  // Own-property check only: a code of "__proto__" must not resolve to anything.
  if (!Object.prototype.hasOwnProperty.call(TABLE, code)) return null
  return TABLE[code] ?? null
}

export function mappedKeyNames(): string[] {
  return Object.values(TABLE)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/shared/keymap.test.ts`
Expected: PASS.

If the integrity test reports missing names, the fork renamed something. Print the truth and fix the table:

```bash
node -e "const {Key}=require('@nut-tree-fork/nut-js');console.log(Object.keys(Key).join(' '))"
```

- [ ] **Step 5: Commit**

```bash
git add src/shared/keymap.ts tests/shared/keymap.test.ts
git commit -m "feat: KeyboardEvent.code to nut.js key mapping with enum integrity test"
```

---

### Task 13: Input injection service (the only nut.js consumer)

**Files:**
- Create: `src/main/input.ts`
- Test: `tests/main/input.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []

vi.mock('@nut-tree-fork/nut-js', () => {
  class Point {
    constructor(
      public x: number,
      public y: number
    ) {}
  }
  return {
    Point,
    Button: { LEFT: 'LEFT', RIGHT: 'RIGHT', MIDDLE: 'MIDDLE' },
    // Any property access returns the property name, so Key.A === 'A'.
    Key: new Proxy({}, { get: (_t, prop) => String(prop) }),
    screen: {
      width: async () => 1920,
      height: async () => 1080
    },
    mouse: {
      config: { autoDelayMs: 100 },
      setPosition: async (p: { x: number; y: number }) => {
        calls.push(`move(${p.x},${p.y})`)
      },
      pressButton: async (b: string) => {
        calls.push(`press(${b})`)
      },
      releaseButton: async (b: string) => {
        calls.push(`release(${b})`)
      },
      scrollUp: async (n: number) => {
        calls.push(`scrollUp(${n})`)
      },
      scrollDown: async (n: number) => {
        calls.push(`scrollDown(${n})`)
      },
      scrollLeft: async (n: number) => {
        calls.push(`scrollLeft(${n})`)
      },
      scrollRight: async (n: number) => {
        calls.push(`scrollRight(${n})`)
      }
    },
    keyboard: {
      config: { autoDelayMs: 100 },
      pressKey: async (k: string) => {
        calls.push(`keyDown(${k})`)
      },
      releaseKey: async (k: string) => {
        calls.push(`keyUp(${k})`)
      }
    }
  }
})

const { applyInputRaw, resetInputState, setInputEnabled } = await import('../../src/main/input')

beforeEach(() => {
  calls.length = 0
  resetInputState()
  setInputEnabled(true)
})

describe('applyInputRaw', () => {
  it('scales a normalized move to screen pixels', async () => {
    await applyInputRaw(JSON.stringify({ t: 'move', x: 0.5, y: 0.5 }))
    expect(calls).toEqual(['move(960,540)'])
  })

  it('translates mouse buttons', async () => {
    await applyInputRaw(JSON.stringify({ t: 'down', b: 'right', x: 0, y: 0 }))
    await applyInputRaw(JSON.stringify({ t: 'up', b: 'right', x: 0, y: 0 }))
    expect(calls).toEqual(['move(0,0)', 'press(RIGHT)', 'move(0,0)', 'release(RIGHT)'])
  })

  it('translates wheel deltas into the right scroll direction', async () => {
    await applyInputRaw(JSON.stringify({ t: 'wheel', dx: 0, dy: 120 }))
    await applyInputRaw(JSON.stringify({ t: 'wheel', dx: -200, dy: 0 }))
    expect(calls).toEqual(['scrollDown(1)', 'scrollLeft(2)'])
  })

  it('presses and releases mapped keys', async () => {
    await applyInputRaw(JSON.stringify({ t: 'keydown', code: 'ShiftLeft' }))
    await applyInputRaw(JSON.stringify({ t: 'keydown', code: 'KeyA' }))
    await applyInputRaw(JSON.stringify({ t: 'keyup', code: 'KeyA' }))
    await applyInputRaw(JSON.stringify({ t: 'keyup', code: 'ShiftLeft' }))
    expect(calls).toEqual(['keyDown(LeftShift)', 'keyDown(A)', 'keyUp(A)', 'keyUp(LeftShift)'])
  })

  it('ignores keys that are not in the map', async () => {
    await applyInputRaw(JSON.stringify({ t: 'keydown', code: 'Fn' }))
    expect(calls).toEqual([])
  })

  it('ignores malformed and out-of-range payloads', async () => {
    await applyInputRaw('{not json')
    await applyInputRaw(JSON.stringify({ t: 'move', x: 42, y: 0 }))
    await applyInputRaw(JSON.stringify({ t: 'exec', cmd: 'rm -rf /' }))
    expect(calls).toEqual([])
  })

  it('does nothing at all while input is disabled', async () => {
    setInputEnabled(false)
    await applyInputRaw(JSON.stringify({ t: 'move', x: 0.5, y: 0.5 }))
    await applyInputRaw(JSON.stringify({ t: 'keydown', code: 'KeyA' }))
    expect(calls).toEqual([])
  })

  it('releases every held key when input is disabled mid-session', async () => {
    await applyInputRaw(JSON.stringify({ t: 'keydown', code: 'ControlLeft' }))
    await applyInputRaw(JSON.stringify({ t: 'down', b: 'left', x: 0, y: 0 }))
    calls.length = 0
    await setInputEnabled(false)
    expect(calls).toEqual(['keyUp(LeftControl)', 'release(LEFT)'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/main/input.test.ts`
Expected: FAIL — cannot resolve `src/main/input`.

- [ ] **Step 3: Write `src/main/input.ts`**

```ts
import { Button, Key, Point, keyboard, mouse, screen } from '@nut-tree-fork/nut-js'
import { normalizedToScreenPixels, wheelDeltaToTicks, type Size } from '../shared/coords'
import { mapKeyCode } from '../shared/keymap'
import { parseInputMessage, parseJson, type InputMessage, type MouseButton } from '../shared/protocol'

// Default nut.js delays are tuned for scripted automation; we need them gone.
mouse.config.autoDelayMs = 0
keyboard.config.autoDelayMs = 0

const BUTTONS: Record<MouseButton, unknown> = {
  left: Button.LEFT,
  right: Button.RIGHT,
  middle: Button.MIDDLE
}

let enabled = false
let cachedScreen: Size | null = null
const heldKeys = new Set<string>()
const heldButtons = new Set<MouseButton>()

export function resetInputState(): void {
  enabled = false
  cachedScreen = null
  heldKeys.clear()
  heldButtons.clear()
}

/**
 * Turning input off also releases anything the remote peer was holding, so a
 * disconnect mid-drag or mid-Cmd cannot leave a key stuck down on this machine.
 */
export async function setInputEnabled(value: boolean): Promise<void> {
  if (enabled && !value) await releaseAll()
  enabled = value
  if (!value) cachedScreen = null
}

export function isInputEnabled(): boolean {
  return enabled
}

async function releaseAll(): Promise<void> {
  for (const name of heldKeys) {
    await keyboard.releaseKey((Key as Record<string, never>)[name])
  }
  heldKeys.clear()
  for (const button of heldButtons) {
    await mouse.releaseButton(BUTTONS[button] as never)
  }
  heldButtons.clear()
}

async function screenSize(): Promise<Size> {
  if (!cachedScreen) {
    cachedScreen = { width: await screen.width(), height: await screen.height() }
  }
  return cachedScreen
}

async function moveTo(x: number, y: number): Promise<void> {
  const px = normalizedToScreenPixels({ x, y }, await screenSize())
  await mouse.setPosition(new Point(px.x, px.y))
}

export async function applyInput(msg: InputMessage): Promise<void> {
  if (!enabled) return

  switch (msg.t) {
    case 'move':
      await moveTo(msg.x, msg.y)
      return

    case 'down':
      await moveTo(msg.x, msg.y)
      heldButtons.add(msg.b)
      await mouse.pressButton(BUTTONS[msg.b] as never)
      return

    case 'up':
      await moveTo(msg.x, msg.y)
      heldButtons.delete(msg.b)
      await mouse.releaseButton(BUTTONS[msg.b] as never)
      return

    case 'wheel': {
      const vertical = wheelDeltaToTicks(msg.dy)
      const horizontal = wheelDeltaToTicks(msg.dx)
      if (vertical > 0) await mouse.scrollDown(vertical)
      else if (vertical < 0) await mouse.scrollUp(-vertical)
      if (horizontal > 0) await mouse.scrollRight(horizontal)
      else if (horizontal < 0) await mouse.scrollLeft(-horizontal)
      return
    }

    case 'keydown': {
      const name = mapKeyCode(msg.code)
      if (!name) return
      heldKeys.add(name)
      await keyboard.pressKey((Key as Record<string, never>)[name])
      return
    }

    case 'keyup': {
      const name = mapKeyCode(msg.code)
      if (!name) return
      heldKeys.delete(name)
      await keyboard.releaseKey((Key as Record<string, never>)[name])
      return
    }
  }
}

/** Entry point for raw data-channel payloads — validates before touching the OS. */
export async function applyInputRaw(raw: string): Promise<void> {
  const msg = parseInputMessage(parseJson(raw))
  if (msg) await applyInput(msg)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/main/input.test.ts`
Expected: PASS — 8 cases.

- [ ] **Step 5: Commit**

```bash
git add src/main/input.ts tests/main/input.test.ts
git commit -m "feat: nut.js input injection with held-key release on disable"
```

---

### Task 14: Capture input on the client, inject it on the host

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/ui/remote-screen.ts`
- Modify: `src/renderer/ui/client-view.ts`
- Modify: `src/renderer/ui/host-view.ts`
- Modify: `src/renderer/rtc/client-session.ts`

- [ ] **Step 1: Add the input IPC handlers to `src/main/ipc.ts`**

Add the import:

```ts
import { applyInputRaw, isInputEnabled, setInputEnabled } from './input'
```

and register these handlers inside `registerIpc()`:

```ts
  ipcMain.handle('input:apply', (_e, raw: string) => applyInputRaw(raw))
  ipcMain.handle('input:set-enabled', (_e, value: boolean) => setInputEnabled(value))
  ipcMain.handle('input:is-enabled', () => isInputEnabled())
```

Also turn input off whenever the host session ends. Change the `SignalingServer` construction's `onClientGone` to:

```ts
      onClientGone: () => {
        void setInputEnabled(false)
        emit('host:client-left', {})
      },
```

and add `await setInputEnabled(false)` as the first line of `stopHost()`.

- [ ] **Step 2: Expose it in `src/preload/index.ts`**

Add to the `api` object, after `client`:

```ts
  input: {
    apply: (raw: string) => ipcRenderer.invoke('input:apply', raw),
    setEnabled: (value: boolean) => ipcRenderer.invoke('input:set-enabled', value),
    isEnabled: () => ipcRenderer.invoke('input:is-enabled')
  },
```

- [ ] **Step 3: Replace `src/renderer/ui/remote-screen.ts` with the input-capturing version**

```ts
import { elementPointToNormalized } from '../../shared/coords'
import type { InputMessage } from '../../shared/protocol'

export interface RemoteScreenOptions {
  send: (msg: InputMessage) => void
}

/**
 * Owns the <video> showing the remote desktop and translates local pointer and
 * keyboard events into normalized InputMessages. Capture is opt-in: nothing is
 * sent until `setControlEnabled(true)`.
 */
export class RemoteScreen {
  readonly el: HTMLDivElement
  readonly video: HTMLVideoElement
  private controlEnabled = false
  private pendingMove: { x: number; y: number } | null = null
  private moveScheduled = false

  constructor(private readonly opts: RemoteScreenOptions) {
    this.el = document.createElement('div')
    this.el.className = 'remote-screen'
    this.video = document.createElement('video')
    this.video.autoplay = true
    this.video.playsInline = true
    this.video.muted = true
    this.video.tabIndex = 0
    this.el.append(this.video)
    this.attachListeners()
  }

  setStream(stream: MediaStream): void {
    this.video.srcObject = stream
  }

  clear(): void {
    this.video.srcObject = null
    this.setControlEnabled(false)
  }

  setControlEnabled(value: boolean): void {
    this.controlEnabled = value
    this.el.classList.toggle('controlling', value)
    if (value) this.video.focus()
  }

  isControlEnabled(): boolean {
    return this.controlEnabled
  }

  /** Pointer position → normalized remote position, or null if outside the image. */
  private normalize(event: PointerEvent | WheelEvent): { x: number; y: number } | null {
    const rect = this.video.getBoundingClientRect()
    return elementPointToNormalized(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      { width: rect.width, height: rect.height },
      { width: this.video.videoWidth, height: this.video.videoHeight }
    )
  }

  /** Coalesce moves to one per frame; a raw pointermove stream would flood the channel. */
  private queueMove(point: { x: number; y: number }): void {
    this.pendingMove = point
    if (this.moveScheduled) return
    this.moveScheduled = true
    requestAnimationFrame(() => {
      this.moveScheduled = false
      const move = this.pendingMove
      this.pendingMove = null
      if (move) this.opts.send({ t: 'move', x: move.x, y: move.y })
    })
  }

  private button(event: PointerEvent): 'left' | 'right' | 'middle' | null {
    if (event.button === 0) return 'left'
    if (event.button === 1) return 'middle'
    if (event.button === 2) return 'right'
    return null
  }

  private attachListeners(): void {
    this.video.addEventListener('pointermove', (event) => {
      if (!this.controlEnabled) return
      const point = this.normalize(event)
      if (point) this.queueMove(point)
    })

    this.video.addEventListener('pointerdown', (event) => {
      if (!this.controlEnabled) return
      const point = this.normalize(event)
      const button = this.button(event)
      if (!point || !button) return
      event.preventDefault()
      this.video.focus()
      this.opts.send({ t: 'down', b: button, x: point.x, y: point.y })
    })

    this.video.addEventListener('pointerup', (event) => {
      if (!this.controlEnabled) return
      const point = this.normalize(event)
      const button = this.button(event)
      if (!point || !button) return
      event.preventDefault()
      this.opts.send({ t: 'up', b: button, x: point.x, y: point.y })
    })

    this.video.addEventListener('contextmenu', (event) => {
      if (this.controlEnabled) event.preventDefault()
    })

    this.video.addEventListener(
      'wheel',
      (event) => {
        if (!this.controlEnabled) return
        event.preventDefault()
        this.opts.send({ t: 'wheel', dx: event.deltaX, dy: event.deltaY })
      },
      { passive: false }
    )

    this.video.addEventListener('keydown', (event) => {
      if (!this.controlEnabled) return
      event.preventDefault()
      this.opts.send({ t: 'keydown', code: event.code })
    })

    this.video.addEventListener('keyup', (event) => {
      if (!this.controlEnabled) return
      event.preventDefault()
      this.opts.send({ t: 'keyup', code: event.code })
    })

    // Losing focus must not leave modifiers stuck down on the remote machine.
    this.video.addEventListener('blur', () => {
      if (!this.controlEnabled) return
      for (const code of ['ShiftLeft', 'ControlLeft', 'AltLeft', 'MetaLeft']) {
        this.opts.send({ t: 'keyup', code })
      }
    })
  }
}
```

- [ ] **Step 4: Add an input channel sender to `src/renderer/rtc/client-session.ts`**

Add this method to `ClientSession` (next to `channel()`):

```ts
  sendInput(msg: InputMessage): void {
    const ch = this.peer?.channels.input
    if (ch?.readyState === 'open') ch.send(JSON.stringify(msg))
  }
```

and extend the import at the top of the file:

```ts
import { parseSignalMessage, type InputMessage } from '../../shared/protocol'
```

- [ ] **Step 5: Wire the control toggle in `src/renderer/ui/client-view.ts`**

Replace the `const screen = new RemoteScreen()` line and the `session` declaration with this ordering (the screen needs the session, so declare `session` first with a late-bound reference):

```ts
  let session: ClientSession

  const screen = new RemoteScreen({
    send: (msg) => session.sendInput(msg)
  })
  root.append(screen.el)

  const setStatus = (text: string): void => {
    statusEl.textContent = text
  }

  session = new ClientSession({
    onStatus: setStatus,
    onStream: (stream) => screen.setStream(stream),
    onCtrlMessage: () => undefined, // wired in Task 16
    onFileChunk: () => undefined // wired in Task 15
  })
```

Add a control checkbox to the markup — insert this line into `root.innerHTML` just before `<p class="status" ...>`:

```html
    <label class="row"><input type="checkbox" id="cl-control" /> Take control of mouse &amp; keyboard</label>
```

and wire it after the other button handlers:

```ts
  const controlToggle = root.querySelector<HTMLInputElement>('#cl-control')!
  controlToggle.onchange = () => screen.setControlEnabled(controlToggle.checked)
```

Also uncheck it on disconnect — add to the `disconnectBtn.onclick` handler and to `onClosed`:

```ts
    controlToggle.checked = false
```

- [ ] **Step 6: Inject received input on the host, in `src/renderer/ui/host-view.ts`**

Replace the `onInputMessage` line of the `HostSession` callbacks with:

```ts
    onInputMessage: (raw) => void window.rd.input.apply(raw),
```

and enable injection once a client is connected. In the `onClientJoined` handler, after `await session.start()`, add:

```ts
      await window.rd.input.setEnabled(true)
```

Add an "allow control" switch so the host can revoke it live. Insert into `root.innerHTML` before the status paragraph:

```html
    <label class="row"><input type="checkbox" id="host-allow-input" checked /> Allow this client to control my mouse &amp; keyboard</label>
```

and wire it:

```ts
  const allowInput = root.querySelector<HTMLInputElement>('#host-allow-input')!
  allowInput.onchange = () => void window.rd.input.setEnabled(allowInput.checked)
```

- [ ] **Step 7: Add the control styling to `src/renderer/styles.css`**

```css
.remote-screen.controlling { outline: 2px solid #2da44e; }
.remote-screen video { cursor: default; }
.remote-screen.controlling video { cursor: crosshair; }
```

- [ ] **Step 8: Verify typecheck and unit tests**

```bash
npm run typecheck && npm test
```
Expected: clean typecheck; all test files pass.

- [ ] **Step 9: Manual verification — the M2 acceptance test**

1. Host machine: start sharing (grant **Accessibility** when macOS asks — System Settings → Privacy & Security → Accessibility → enable RemoteDesk/Electron, then relaunch `npm run dev`).
2. Client machine: connect, then tick *Take control of mouse & keyboard* and click into the video.
3. Expected: moving the mouse over the video moves the host's cursor to the matching spot; clicking activates host windows; typing lands in the host's focused app; two-finger scroll scrolls the host.
4. Untick the host's *Allow this client to control…* → the client's input stops having any effect immediately.
5. While holding <kbd>Shift</kbd> on the client, click away to another app → the host must not be left with Shift stuck down.

Troubleshooting:
- cursor moves but is offset → the host has multiple displays and `screen.width()` returns only the primary. v1 shares the primary screen; select the primary in the host's screen dropdown.
- nothing happens on macOS → Accessibility not granted, or granted to the wrong binary (in dev it is *Electron*, in the packaged app it is *RemoteDesk*; both need separate grants).
- nothing happens on Windows only in one app → that app is running elevated; see the Windows note in "Critical context".

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(M2): capture client input and inject it on the host"
```

---
# M3 — Files, links, clipboard

### Task 15: File chunking and reassembly

**Files:**
- Create: `src/shared/filechunk.ts`
- Test: `tests/shared/filechunk.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { FILE_CHUNK_SIZE } from '../../src/shared/protocol'
import { FileReassembler, chunkBuffer, sha256Hex } from '../../src/shared/filechunk'

function makeBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = i % 256
  return out
}

describe('chunkBuffer', () => {
  it('splits into full chunks plus a remainder', () => {
    const chunks = chunkBuffer(makeBytes(40_000))
    expect(chunks.map((c) => c.byteLength)).toEqual([FILE_CHUNK_SIZE, FILE_CHUNK_SIZE, 7232])
  })

  it('returns a single chunk for a small payload', () => {
    expect(chunkBuffer(makeBytes(10)).map((c) => c.byteLength)).toEqual([10])
  })

  it('returns no chunks for an empty payload', () => {
    expect(chunkBuffer(makeBytes(0))).toEqual([])
  })

  it('honours a custom chunk size', () => {
    expect(chunkBuffer(makeBytes(10), 4).map((c) => c.byteLength)).toEqual([4, 4, 2])
  })
})

describe('sha256Hex', () => {
  it('hashes the well-known empty input', async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
  })

  it('is stable for the same bytes', async () => {
    const bytes = makeBytes(1000)
    expect(await sha256Hex(bytes)).toBe(await sha256Hex(makeBytes(1000)))
  })
})

describe('FileReassembler', () => {
  it('round-trips a payload through chunks', async () => {
    const original = makeBytes(40_000)
    const hash = await sha256Hex(original)
    const r = new FileReassembler({ id: 'f1', name: 'a.bin', size: original.byteLength, mime: '' })

    for (const chunk of chunkBuffer(original)) r.push(chunk)

    expect(r.isComplete()).toBe(true)
    const result = await r.finish(hash)
    expect(result.byteLength).toBe(original.byteLength)
    expect(Array.from(result.slice(0, 5))).toEqual([0, 1, 2, 3, 4])
  })

  it('reports progress as it goes', () => {
    const r = new FileReassembler({ id: 'f1', name: 'a.bin', size: 100, mime: '' })
    expect(r.progress()).toBe(0)
    r.push(makeBytes(50))
    expect(r.progress()).toBe(0.5)
    expect(r.isComplete()).toBe(false)
  })

  it('rejects more bytes than the declared size', () => {
    const r = new FileReassembler({ id: 'f1', name: 'a.bin', size: 10, mime: '' })
    expect(() => r.push(makeBytes(11))).toThrow(/exceeds/i)
  })

  it('refuses to finish before every byte arrived', async () => {
    const r = new FileReassembler({ id: 'f1', name: 'a.bin', size: 100, mime: '' })
    r.push(makeBytes(50))
    await expect(r.finish('whatever')).rejects.toThrow(/incomplete/i)
  })

  it('refuses to finish when the hash does not match', async () => {
    const r = new FileReassembler({ id: 'f1', name: 'a.bin', size: 10, mime: '' })
    r.push(makeBytes(10))
    await expect(r.finish('0'.repeat(64))).rejects.toThrow(/checksum/i)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/shared/filechunk.test.ts`
Expected: FAIL — cannot resolve `src/shared/filechunk`.

- [ ] **Step 3: Write `src/shared/filechunk.ts`**

```ts
import { FILE_CHUNK_SIZE } from './protocol'

export interface FileMeta {
  id: string
  name: string
  size: number
  mime: string
}

export function chunkBuffer(data: Uint8Array, chunkSize: number = FILE_CHUNK_SIZE): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
    chunks.push(data.subarray(offset, Math.min(offset + chunkSize, data.byteLength)))
  }
  return chunks
}

/** WebCrypto is available both in the renderer and in Node 20+, so this module stays portable. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export class FileReassembler {
  private readonly parts: Uint8Array[] = []
  private received = 0

  constructor(readonly meta: FileMeta) {}

  push(chunk: Uint8Array): void {
    if (this.received + chunk.byteLength > this.meta.size) {
      throw new Error(
        `chunk exceeds declared size for ${this.meta.name}: ${this.received + chunk.byteLength} > ${this.meta.size}`
      )
    }
    this.parts.push(chunk)
    this.received += chunk.byteLength
  }

  receivedBytes(): number {
    return this.received
  }

  progress(): number {
    return this.meta.size === 0 ? 1 : this.received / this.meta.size
  }

  isComplete(): boolean {
    return this.received === this.meta.size
  }

  async finish(expectedSha256: string): Promise<Uint8Array> {
    if (!this.isComplete()) {
      throw new Error(`transfer incomplete: ${this.received}/${this.meta.size} bytes`)
    }
    const out = new Uint8Array(this.meta.size)
    let offset = 0
    for (const part of this.parts) {
      out.set(part, offset)
      offset += part.byteLength
    }
    const actual = await sha256Hex(out)
    if (actual !== expectedSha256) {
      throw new Error(`checksum mismatch for ${this.meta.name}`)
    }
    return out
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/shared/filechunk.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/filechunk.ts tests/shared/filechunk.test.ts
git commit -m "feat: file chunker and checksum-verified reassembler"
```

---

### Task 16: Send and receive files over the data channel

Transfers go both directions with the same code, so this lives in one renderer module used by both roles.

**Files:**
- Create: `src/renderer/rtc/file-transfer.ts`
- Create: `src/renderer/ui/transfer-panel.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/ui/client-view.ts`
- Modify: `src/renderer/ui/host-view.ts`
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: Write `src/renderer/rtc/file-transfer.ts`**

```ts
import { FileReassembler, chunkBuffer, sha256Hex, type FileMeta } from '../../shared/filechunk'
import { DATA_CHANNEL_HIGH_WATER, type CtrlMessage } from '../../shared/protocol'

export interface SendProgress {
  name: string
  sent: number
  total: number
}

function waitForDrain(channel: RTCDataChannel): Promise<void> {
  return new Promise((resolve) => {
    channel.bufferedAmountLowThreshold = Math.floor(DATA_CHANNEL_HIGH_WATER / 2)
    const handler = (): void => {
      channel.removeEventListener('bufferedamountlow', handler)
      resolve()
    }
    channel.addEventListener('bufferedamountlow', handler)
  })
}

/** Sends one file: metadata on ctrl, bytes on file, checksum on ctrl. */
export async function sendFile(args: {
  ctrl: RTCDataChannel
  file: RTCDataChannel
  blob: File
  onProgress: (p: SendProgress) => void
}): Promise<void> {
  const { ctrl, file, blob, onProgress } = args
  if (ctrl.readyState !== 'open' || file.readyState !== 'open') {
    throw new Error('not connected')
  }

  const bytes = new Uint8Array(await blob.arrayBuffer())
  const id = globalThis.crypto.randomUUID()
  const begin: CtrlMessage = {
    t: 'file-begin',
    id,
    name: blob.name,
    size: bytes.byteLength,
    mime: blob.type
  }
  ctrl.send(JSON.stringify(begin))

  let sent = 0
  for (const chunk of chunkBuffer(bytes)) {
    if (file.bufferedAmount > DATA_CHANNEL_HIGH_WATER) await waitForDrain(file)
    file.send(chunk as unknown as ArrayBuffer)
    sent += chunk.byteLength
    onProgress({ name: blob.name, sent, total: bytes.byteLength })
  }

  const end: CtrlMessage = { t: 'file-end', id, sha256: await sha256Hex(bytes) }
  ctrl.send(JSON.stringify(end))
}

/**
 * Receiving side. Only one transfer is in flight at a time (the sender queues),
 * so a single active reassembler is enough.
 */
export class FileReceiver {
  private active: FileReassembler | null = null

  constructor(
    private readonly cb: {
      onProgress: (name: string, progress: number) => void
      onDone: (name: string, mime: string, bytes: Uint8Array) => void
      onError: (message: string) => void
    }
  ) {}

  begin(meta: FileMeta): void {
    this.active = new FileReassembler(meta)
    this.cb.onProgress(meta.name, 0)
  }

  chunk(data: ArrayBuffer): void {
    if (!this.active) return
    try {
      this.active.push(new Uint8Array(data))
      this.cb.onProgress(this.active.meta.name, this.active.progress())
    } catch (err) {
      this.cb.onError((err as Error).message)
      this.active = null
    }
  }

  async end(sha256: string): Promise<void> {
    const active = this.active
    this.active = null
    if (!active) return
    try {
      const bytes = await active.finish(sha256)
      this.cb.onDone(active.meta.name, active.meta.mime, bytes)
    } catch (err) {
      this.cb.onError((err as Error).message)
    }
  }

  reset(): void {
    this.active = null
  }
}
```

- [ ] **Step 2: Add the save handler to `src/main/ipc.ts`**

Extend the imports:

```ts
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
```

and register:

```ts
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
```

- [ ] **Step 3: Expose it in `src/preload/index.ts`**

Add to the `api` object:

```ts
  files: {
    save: (name: string, data: Uint8Array) => ipcRenderer.invoke('file:save', { name, data })
  },
```

- [ ] **Step 4: Write `src/renderer/ui/transfer-panel.ts`**

```ts
import { parseCtrlMessage, parseJson } from '../../shared/protocol'
import { normalizeExternalUrl } from '../../shared/url-guard'
import { FileReceiver, sendFile } from '../rtc/file-transfer'

export interface TransferPanelPorts {
  /** Returns the live data channels, or undefined when not connected. */
  channels: () => { ctrl?: RTCDataChannel; file?: RTCDataChannel }
}

export class TransferPanel {
  readonly el: HTMLElement
  private readonly log: HTMLElement
  private readonly queue: File[] = []
  private busy = false
  private readonly receiver: FileReceiver

  constructor(private readonly ports: TransferPanelPorts) {
    this.el = document.createElement('div')
    this.el.className = 'transfer'
    this.el.innerHTML = `
      <div class="dropzone" id="tp-drop">Drop files or images here to send</div>
      <div class="row">
        <input type="file" id="tp-picker" multiple />
        <input type="text" id="tp-link" placeholder="https://… send a link" />
        <button id="tp-send-link">Send link</button>
      </div>
      <ul class="log" id="tp-log"></ul>
    `
    this.log = this.el.querySelector<HTMLElement>('#tp-log')!

    this.receiver = new FileReceiver({
      onProgress: (name, progress) =>
        this.say(`receiving ${name} — ${Math.round(progress * 100)}%`, true),
      onDone: (name, _mime, bytes) => void this.saveReceived(name, bytes),
      onError: (message) => this.say(`receive failed: ${message}`)
    })

    this.attach()
  }

  private attach(): void {
    const drop = this.el.querySelector<HTMLElement>('#tp-drop')!
    const picker = this.el.querySelector<HTMLInputElement>('#tp-picker')!
    const linkInput = this.el.querySelector<HTMLInputElement>('#tp-link')!
    const sendLinkBtn = this.el.querySelector<HTMLButtonElement>('#tp-send-link')!

    drop.addEventListener('dragover', (event) => {
      event.preventDefault()
      drop.classList.add('over')
    })
    drop.addEventListener('dragleave', () => drop.classList.remove('over'))
    drop.addEventListener('drop', (event) => {
      event.preventDefault()
      drop.classList.remove('over')
      const files = event.dataTransfer?.files
      if (files) this.enqueue([...files])
    })

    picker.addEventListener('change', () => {
      if (picker.files) this.enqueue([...picker.files])
      picker.value = ''
    })

    sendLinkBtn.addEventListener('click', () => {
      const raw = linkInput.value.trim()
      if (!raw) return
      const safe = normalizeExternalUrl(raw)
      if (!safe) {
        this.say(`not a valid http(s) link: ${raw}`)
        return
      }
      const ctrl = this.ports.channels().ctrl
      if (ctrl?.readyState !== 'open') {
        this.say('not connected')
        return
      }
      ctrl.send(JSON.stringify({ t: 'link', url: safe }))
      this.say(`link sent: ${safe}`)
      linkInput.value = ''
    })
  }

  /** Called by the session when a ctrl-channel string arrives. */
  handleCtrl(raw: string): void {
    const msg = parseCtrlMessage(parseJson(raw))
    if (!msg) return

    if (msg.t === 'file-begin') {
      this.receiver.begin({ id: msg.id, name: msg.name, size: msg.size, mime: msg.mime })
    } else if (msg.t === 'file-end') {
      void this.receiver.end(msg.sha256)
    } else if (msg.t === 'file-ack') {
      this.say(msg.ok ? 'peer saved the file' : `peer could not save it: ${msg.message ?? ''}`)
    } else if (msg.t === 'link') {
      void window.rd.openExternal(msg.url).then((result) => {
        const r = result as { opened: boolean; reason?: string; url?: string }
        this.say(r.opened ? `opened link: ${r.url}` : `link blocked (${r.reason})`)
      })
    } else if (msg.t === 'clip-text') {
      void window.rd.clipboard.applyRemote({ kind: 'text', text: msg.text })
      this.say(`clipboard updated from peer (${msg.text.length} chars)`)
    } else if (msg.t === 'clip-image') {
      void window.rd.clipboard.applyRemote({ kind: 'image', dataUrl: msg.dataUrl })
      this.say('clipboard image updated from peer')
    }
  }

  handleChunk(chunk: ArrayBuffer): void {
    this.receiver.chunk(chunk)
  }

  reset(): void {
    this.receiver.reset()
    this.queue.length = 0
    this.busy = false
  }

  private enqueue(files: File[]): void {
    this.queue.push(...files)
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      while (this.queue.length > 0) {
        const blob = this.queue.shift()!
        const { ctrl, file } = this.ports.channels()
        if (!ctrl || !file) {
          this.say('not connected — transfer cancelled')
          this.queue.length = 0
          return
        }
        this.say(`sending ${blob.name}…`)
        try {
          await sendFile({
            ctrl,
            file,
            blob,
            onProgress: (p) =>
              this.say(`sending ${p.name} — ${Math.round((p.sent / p.total) * 100)}%`, true)
          })
          this.say(`sent ${blob.name}`)
        } catch (err) {
          this.say(`send failed: ${(err as Error).message}`)
        }
      }
    } finally {
      this.busy = false
    }
  }

  private async saveReceived(name: string, bytes: Uint8Array): Promise<void> {
    const result = (await window.rd.files.save(name, bytes)) as
      | { saved: true; path: string }
      | { saved: false }
    this.say(result.saved ? `saved to ${result.path}` : `save cancelled for ${name}`)
    const ctrl = this.ports.channels().ctrl
    if (ctrl?.readyState === 'open') {
      ctrl.send(JSON.stringify({ t: 'file-ack', id: name, ok: result.saved }))
    }
  }

  /** `replace: true` overwrites the last line, so progress does not spam the log. */
  say(text: string, replace = false): void {
    if (replace && this.log.firstElementChild) {
      this.log.firstElementChild.textContent = text
      return
    }
    const li = document.createElement('li')
    li.textContent = text
    this.log.prepend(li)
    while (this.log.childElementCount > 40) this.log.lastElementChild?.remove()
  }
}
```

Note: `handleCtrl` already contains the `link`, `clip-text` and `clip-image` branches that Tasks 17 and 18 rely on, and imports `normalizeExternalUrl` from Task 17. Write Task 17's `src/shared/url-guard.ts` before running `npm run typecheck` here, or accept one unresolved import until Task 17's Step 3.

- [ ] **Step 5: Mount the panel in `src/renderer/ui/client-view.ts`**

Add the import:

```ts
import { TransferPanel } from './transfer-panel'
```

The panel and the session reference each other, so declare both bindings first and assign in order. Replace the `screen` / `session` block with:

```ts
  let session: ClientSession
  let transfer: TransferPanel

  const screen = new RemoteScreen({
    send: (msg) => session.sendInput(msg)
  })
  root.append(screen.el)

  const setStatus = (text: string): void => {
    statusEl.textContent = text
  }

  session = new ClientSession({
    onStatus: setStatus,
    onStream: (stream) => screen.setStream(stream),
    onCtrlMessage: (raw) => transfer.handleCtrl(raw),
    onFileChunk: (chunk) => transfer.handleChunk(chunk)
  })

  transfer = new TransferPanel({
    channels: () => ({ ctrl: session.channel('ctrl'), file: session.channel('file') })
  })
  root.append(transfer.el)
```

Call `transfer.reset()` inside `disconnectBtn.onclick` and inside the `onClosed` handler.

- [ ] **Step 6: Mount the same panel in `src/renderer/ui/host-view.ts`**

Identical wiring with the host session. Replace the `const session = new HostSession({...})` block with:

```ts
  let transfer: TransferPanel

  const session = new HostSession({
    onStatus: setStatus,
    onInputMessage: (raw) => void window.rd.input.apply(raw),
    onCtrlMessage: (raw) => transfer.handleCtrl(raw),
    onFileChunk: (chunk) => transfer.handleChunk(chunk)
  })

  transfer = new TransferPanel({
    channels: () => ({ ctrl: session.channel('ctrl'), file: session.channel('file') })
  })
  root.append(transfer.el)
```

Call `transfer.reset()` in the `onClientLeft` handler and in `stopBtn.onclick`.

- [ ] **Step 7: Add styling to `src/renderer/styles.css`**

```css
.transfer { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; }
.dropzone {
  border: 2px dashed currentColor; opacity: 0.5; border-radius: 8px;
  padding: 20px; text-align: center; font-size: 13px;
}
.dropzone.over { opacity: 1; }
.log { list-style: none; margin: 0; padding: 0; font-size: 12px; max-height: 160px; overflow-y: auto; }
.log li { padding: 2px 0; opacity: 0.8; }
```

- [ ] **Step 8: Verify typecheck and tests**

```bash
npm run typecheck && npm test
```
Expected: clean once Tasks 17 and 18 have added `url-guard.ts` and the `clipboard` preload API. If you are executing strictly in order, run this check at the end of Task 18 instead.

- [ ] **Step 9: Manual verification**

1. Connect the two machines as in M1.
2. Drag a PNG onto the client's drop zone. The host shows a Save dialog; save it. The client logs "peer saved the file".
3. Drag a ~50 MB file from the host to the client. Progress climbs and the file arrives intact — confirm with `shasum <file>` on both machines.
4. Cancel the Save dialog once. The sender logs that the peer could not save it and the session stays connected.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(M3): bidirectional file transfer with checksum and save dialog"
```

---

### Task 17: Safe link opening

A remote peer can push a URL that this machine will open. Anything but `http`/`https` is a local-code-execution vector, so validation is strict and tested.

**Files:**
- Create: `src/shared/url-guard.ts`
- Test: `tests/shared/url-guard.test.ts`
- Modify: `src/main/ipc.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { isSafeExternalUrl, normalizeExternalUrl } from '../../src/shared/url-guard'

describe('normalizeExternalUrl', () => {
  it('accepts http and https urls', () => {
    expect(normalizeExternalUrl('https://example.com')).toBe('https://example.com/')
    expect(normalizeExternalUrl('http://192.168.1.5:8080/path?q=1')).toBe(
      'http://192.168.1.5:8080/path?q=1'
    )
  })

  it('adds https:// to a bare host', () => {
    expect(normalizeExternalUrl('example.com/docs')).toBe('https://example.com/docs')
  })

  it('rejects dangerous schemes, in any casing or with padding', () => {
    expect(normalizeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeExternalUrl('  JavaScript:alert(1)  ')).toBeNull()
    expect(normalizeExternalUrl('java\nscript:alert(1)')).toBeNull()
    expect(normalizeExternalUrl('data:text/html,<script>x</script>')).toBeNull()
    expect(normalizeExternalUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeExternalUrl('vbscript:x')).toBeNull()
    expect(normalizeExternalUrl('about:blank')).toBeNull()
  })

  it('rejects urls carrying embedded credentials', () => {
    expect(normalizeExternalUrl('https://user:pass@evil.example')).toBeNull()
  })

  it('rejects empty, hostless and absurdly long input', () => {
    expect(normalizeExternalUrl('')).toBeNull()
    expect(normalizeExternalUrl('   ')).toBeNull()
    expect(normalizeExternalUrl('https://')).toBeNull()
    expect(normalizeExternalUrl(`https://example.com/${'a'.repeat(3000)}`)).toBeNull()
  })

  it('rejects non-string input', () => {
    expect(normalizeExternalUrl(undefined as unknown as string)).toBeNull()
  })
})

describe('isSafeExternalUrl', () => {
  it('agrees with normalizeExternalUrl', () => {
    expect(isSafeExternalUrl('https://example.com')).toBe(true)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
  })
})
```

Note on the `java\nscript:alert(1)` case: that is a real newline inside the string. Stripping control characters turns it into `javascript:alert(1)`, which must then be rejected by the scheme allowlist — the test proves both halves work.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/shared/url-guard.test.ts`
Expected: FAIL — cannot resolve `src/shared/url-guard`.

- [ ] **Step 3: Write `src/shared/url-guard.ts`**

```ts
const MAX_URL_LENGTH = 2048
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

// Matches ASCII control characters (U+0000–U+001F plus U+007F), which a hostile
// peer can use to disguise a scheme, e.g. "java\nscript:".
const CONTROL_CHARS = /[ -]/g
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** Returns a normalized http(s) URL, or null if the input is unsafe. */
export function normalizeExternalUrl(raw: string): string | null {
  if (typeof raw !== 'string') return null

  const cleaned = raw.replace(CONTROL_CHARS, '').trim()
  if (!cleaned || cleaned.length > MAX_URL_LENGTH) return null

  const withScheme = HAS_SCHEME.test(cleaned) ? cleaned : `https://${cleaned}`

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null
  if (!url.hostname) return null
  // Embedded credentials are a classic phishing disguise: https://bank.com@evil.tld
  if (url.username || url.password) return null
  if (url.href.length > MAX_URL_LENGTH) return null

  return url.href
}

export function isSafeExternalUrl(raw: string): boolean {
  return normalizeExternalUrl(raw) !== null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/shared/url-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Enforce the guard in `src/main/ipc.ts`**

Add the import:

```ts
import { normalizeExternalUrl } from '../shared/url-guard'
```

and replace the `shell:open-external` handler with:

```ts
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
```

The confirmation dialog matters: a link arriving over the network is not the same as the local user clicking one.

- [ ] **Step 6: Manual verification**

With both machines connected, type `example.com` into the client's link box and press *Send link*. The host shows a confirmation dialog; *Open* launches the host's default browser at `https://example.com/`.

- [ ] **Step 7: Commit**

```bash
git add src/shared/url-guard.ts tests/shared/url-guard.test.ts src/main/ipc.ts
git commit -m "feat(M3): send links with strict url validation and host confirmation"
```

---

### Task 18: Clipboard sync

**Files:**
- Create: `src/shared/clipboard-sync.ts`
- Test: `tests/shared/clipboard-sync.test.ts`
- Create: `src/main/clipboard.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/ui/client-view.ts`
- Modify: `src/renderer/ui/host-view.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { ClipboardSync, type ClipSnapshot } from '../../src/shared/clipboard-sync'

let local: ClipSnapshot | null
let writes: ClipSnapshot[]
let sync: ClipboardSync

beforeEach(() => {
  local = { kind: 'text', text: 'initial' }
  writes = []
  sync = new ClipboardSync({
    read: () => local,
    write: (snapshot) => {
      writes.push(snapshot)
      local = snapshot
    }
  })
})

describe('ClipboardSync', () => {
  it('does not push whatever was already on the clipboard at startup', () => {
    expect(sync.poll()).toBeNull()
  })

  it('pushes the clipboard after a local copy', () => {
    sync.poll()
    local = { kind: 'text', text: 'copied by me' }
    expect(sync.poll()).toEqual({ kind: 'text', text: 'copied by me' })
  })

  it('reports nothing while the clipboard is unchanged', () => {
    sync.poll()
    local = { kind: 'text', text: 'copied by me' }
    expect(sync.poll()).not.toBeNull()
    expect(sync.poll()).toBeNull()
    expect(sync.poll()).toBeNull()
  })

  it('writes a remote snapshot locally', () => {
    sync.poll()
    sync.applyRemote({ kind: 'text', text: 'from peer' })
    expect(writes).toEqual([{ kind: 'text', text: 'from peer' }])
  })

  it('never echoes a remote snapshot back to the peer', () => {
    sync.poll()
    sync.applyRemote({ kind: 'text', text: 'from peer' })
    expect(sync.poll()).toBeNull()
  })

  it('pushes again after a local copy that follows a remote write', () => {
    sync.poll()
    sync.applyRemote({ kind: 'text', text: 'from peer' })
    local = { kind: 'text', text: 'mine again' }
    expect(sync.poll()).toEqual({ kind: 'text', text: 'mine again' })
  })

  it('handles images by data url', () => {
    sync.poll()
    local = { kind: 'image', dataUrl: 'data:image/png;base64,AAAA' }
    expect(sync.poll()).toEqual({ kind: 'image', dataUrl: 'data:image/png;base64,AAAA' })
    expect(sync.poll()).toBeNull()
  })

  it('skips text larger than the limit instead of flooding the channel', () => {
    const big = new ClipboardSync({
      read: () => local,
      write: (s) => writes.push(s),
      maxTextLength: 10
    })
    big.poll()
    local = { kind: 'text', text: 'x'.repeat(50) }
    expect(big.poll()).toBeNull()
  })

  it('tolerates an unreadable clipboard', () => {
    sync.poll()
    local = null
    expect(sync.poll()).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/shared/clipboard-sync.test.ts`
Expected: FAIL — cannot resolve `src/shared/clipboard-sync`.

- [ ] **Step 3: Write `src/shared/clipboard-sync.ts`**

```ts
export type ClipSnapshot = { kind: 'text'; text: string } | { kind: 'image'; dataUrl: string }

export interface ClipboardPort {
  read: () => ClipSnapshot | null
  write: (snapshot: ClipSnapshot) => void
  maxTextLength?: number
}

const DEFAULT_MAX_TEXT = 256 * 1024

function fingerprint(snapshot: ClipSnapshot): string {
  return snapshot.kind === 'text' ? `t:${snapshot.text}` : `i:${snapshot.dataUrl}`
}

function payloadLength(snapshot: ClipSnapshot): number {
  return snapshot.kind === 'text' ? snapshot.text.length : snapshot.dataUrl.length
}

/**
 * Detects local clipboard changes worth sending, and remembers what it wrote on
 * the peer's behalf so the same content never bounces back and forth forever.
 */
export class ClipboardSync {
  private lastSeen: string | null = null
  private primed = false

  constructor(private readonly port: ClipboardPort) {}

  /** Call on a timer. Returns the snapshot to send, or null if there is nothing new. */
  poll(): ClipSnapshot | null {
    const snapshot = this.port.read()
    if (!snapshot) return null

    const print = fingerprint(snapshot)

    // The first poll only records a baseline: never dump the pre-existing clipboard.
    if (!this.primed) {
      this.primed = true
      this.lastSeen = print
      return null
    }

    if (print === this.lastSeen) return null
    this.lastSeen = print

    const limit = this.port.maxTextLength ?? DEFAULT_MAX_TEXT
    if (payloadLength(snapshot) > limit) return null

    return snapshot
  }

  /** Write a peer's clipboard locally and suppress the echo. */
  applyRemote(snapshot: ClipSnapshot): void {
    this.lastSeen = fingerprint(snapshot)
    this.primed = true
    this.port.write(snapshot)
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/shared/clipboard-sync.test.ts`
Expected: PASS — 9 cases.

- [ ] **Step 5: Write `src/main/clipboard.ts`**

```ts
import { clipboard, nativeImage } from 'electron'
import { ClipboardSync, type ClipSnapshot } from '../shared/clipboard-sync'

const POLL_INTERVAL_MS = 800

function readClipboard(): ClipSnapshot | null {
  const image = clipboard.readImage()
  if (!image.isEmpty()) return { kind: 'image', dataUrl: image.toDataURL() }
  const text = clipboard.readText()
  return text ? { kind: 'text', text } : null
}

function writeClipboard(snapshot: ClipSnapshot): void {
  if (snapshot.kind === 'text') {
    clipboard.writeText(snapshot.text)
    return
  }
  const image = nativeImage.createFromDataURL(snapshot.dataUrl)
  if (!image.isEmpty()) clipboard.writeImage(image)
}

export class ClipboardWatcher {
  private sync = new ClipboardSync({ read: readClipboard, write: writeClipboard })
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly onLocalChange: (snapshot: ClipSnapshot) => void) {}

  start(): void {
    if (this.timer) return
    // Fresh state per session, so the baseline is taken when sharing starts.
    this.sync = new ClipboardSync({ read: readClipboard, write: writeClipboard })
    this.timer = setInterval(() => {
      const snapshot = this.sync.poll()
      if (snapshot) this.onLocalChange(snapshot)
    }, POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  applyRemote(snapshot: ClipSnapshot): void {
    this.sync.applyRemote(snapshot)
  }
}
```

- [ ] **Step 6: Wire it into `src/main/ipc.ts`**

Add the imports:

```ts
import { ClipboardWatcher } from './clipboard'
import type { ClipSnapshot } from '../shared/clipboard-sync'
```

Create the watcher next to the other module-level state (below `let client: SignalingClient | null = null`):

```ts
const clipboardWatcher = new ClipboardWatcher((snapshot) => emit('clipboard:local', snapshot))
```

Register the handlers inside `registerIpc()`:

```ts
  ipcMain.handle('clipboard:watch', (_e, value: boolean) => {
    if (value) clipboardWatcher.start()
    else clipboardWatcher.stop()
  })
  ipcMain.handle('clipboard:apply-remote', (_e, snapshot: ClipSnapshot) => {
    clipboardWatcher.applyRemote(snapshot)
  })
```

and stop it when a session ends: add `clipboardWatcher.stop()` to `stopHost()` and to the `onClientGone` callback.

- [ ] **Step 7: Expose it in `src/preload/index.ts`**

Add to the `api` object:

```ts
  clipboard: {
    watch: (value: boolean) => ipcRenderer.invoke('clipboard:watch', value),
    applyRemote: (snapshot: unknown) => ipcRenderer.invoke('clipboard:apply-remote', snapshot),
    onLocalChange: (cb: (p: unknown) => void) => on('clipboard:local', cb)
  },
```

- [ ] **Step 8: Send local clipboard changes from both views**

Add this block to **both** `src/renderer/ui/client-view.ts` and `src/renderer/ui/host-view.ts`, right after the transfer panel is appended. The clipboard API is role-independent, so the code is identical in both files:

```ts
  // Local clipboard changes go out on the ctrl channel; incoming ones are applied
  // by TransferPanel.handleCtrl.
  window.rd.clipboard.onLocalChange((snapshot) => {
    const ctrl = session.channel('ctrl')
    if (ctrl?.readyState !== 'open') return
    const snap = snapshot as { kind: 'text'; text: string } | { kind: 'image'; dataUrl: string }
    ctrl.send(
      JSON.stringify(
        snap.kind === 'text'
          ? { t: 'clip-text', text: snap.text }
          : { t: 'clip-image', dataUrl: snap.dataUrl }
      )
    )
  })
```

Start and stop the watcher with the session:
- `client-view.ts`: `void window.rd.clipboard.watch(true)` inside the `onConnected` handler; `void window.rd.clipboard.watch(false)` in `disconnectBtn.onclick` and in the `onClosed` handler.
- `host-view.ts`: `void window.rd.clipboard.watch(true)` inside `onClientJoined`; `void window.rd.clipboard.watch(false)` in `onClientLeft` and in `stopBtn.onclick`.

- [ ] **Step 9: Verify typecheck and the whole suite**

```bash
npm run typecheck && npm test
```
Expected: clean typecheck; every test file passes. This is also the deferred check from Task 16 Step 8.

- [ ] **Step 10: Manual verification — the M3 acceptance test**

With both machines connected:
1. Copy text on the client, paste on the host — same text.
2. Copy a screenshot on the host, paste on the client — same image.
3. Copy text on the client, wait 5 seconds, read both logs — exactly one clipboard update, no ping-pong loop.
4. Send a file, a link and a clipboard change in quick succession — all three arrive, and screen control stays responsive (the file bytes ride a separate channel from input).

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(M3): echo-free clipboard sync for text and images"
```

---
# M4 — Permissions, session approval, installers

### Task 19: macOS permission gate

**Files:**
- Create: `src/main/permissions.ts`
- Test: `tests/main/permissions.test.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Create: `src/renderer/ui/permission-gate.ts`
- Modify: `src/renderer/ui/host-view.ts`
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
  platform: 'darwin' as NodeJS.Platform,
  mediaAccess: 'granted' as string,
  trusted: true,
  opened: [] as string[]
}

vi.mock('electron', () => ({
  systemPreferences: {
    getMediaAccessStatus: (_kind: string) => state.mediaAccess,
    isTrustedAccessibilityClient: (_prompt: boolean) => state.trusted
  },
  shell: {
    openExternal: async (url: string) => {
      state.opened.push(url)
    }
  }
}))

const { getPermissionState, openAccessibilitySettings, openScreenRecordingSettings } =
  await import('../../src/main/permissions')

beforeEach(() => {
  state.platform = 'darwin'
  state.mediaAccess = 'granted'
  state.trusted = true
  state.opened.length = 0
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
})

describe('getPermissionState on macOS', () => {
  it('reports both permissions as granted', () => {
    expect(getPermissionState()).toEqual({
      platform: 'darwin',
      screenRecording: 'granted',
      accessibility: 'granted',
      ready: true
    })
  })

  it('reports a missing screen recording grant', () => {
    state.mediaAccess = 'denied'
    const result = getPermissionState()
    expect(result.screenRecording).toBe('denied')
    expect(result.ready).toBe(false)
  })

  it('reports a missing accessibility grant', () => {
    state.trusted = false
    const result = getPermissionState()
    expect(result.accessibility).toBe('denied')
    expect(result.ready).toBe(false)
  })

  it('passes through the not-determined state', () => {
    state.mediaAccess = 'not-determined'
    expect(getPermissionState().screenRecording).toBe('not-determined')
  })
})

describe('getPermissionState on other platforms', () => {
  it('needs no permissions on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    expect(getPermissionState()).toEqual({
      platform: 'win32',
      screenRecording: 'not-needed',
      accessibility: 'not-needed',
      ready: true
    })
  })
})

describe('settings deep links', () => {
  it('opens the Screen Recording pane', async () => {
    await openScreenRecordingSettings()
    expect(state.opened[0]).toContain('Privacy_ScreenCapture')
  })

  it('opens the Accessibility pane', async () => {
    await openAccessibilitySettings()
    expect(state.opened[0]).toContain('Privacy_Accessibility')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/main/permissions.test.ts`
Expected: FAIL — cannot resolve `src/main/permissions`.

- [ ] **Step 3: Write `src/main/permissions.ts`**

```ts
import { shell, systemPreferences } from 'electron'

export type PermissionStatus = 'granted' | 'denied' | 'not-determined' | 'not-needed'

export interface PermissionState {
  platform: string
  screenRecording: PermissionStatus
  accessibility: PermissionStatus
  /** True when this machine can act as a host right now. */
  ready: boolean
}

const SCREEN_RECORDING_PANE =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
const ACCESSIBILITY_PANE =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'

function mapMediaStatus(status: string): PermissionStatus {
  if (status === 'granted') return 'granted'
  if (status === 'not-determined' || status === 'unknown') return 'not-determined'
  return 'denied'
}

export function getPermissionState(): PermissionState {
  if (process.platform !== 'darwin') {
    return {
      platform: process.platform,
      screenRecording: 'not-needed',
      accessibility: 'not-needed',
      ready: true
    }
  }

  const screenRecording = mapMediaStatus(systemPreferences.getMediaAccessStatus('screen'))
  // Passing false checks without showing the system prompt.
  const accessibility: PermissionStatus = systemPreferences.isTrustedAccessibilityClient(false)
    ? 'granted'
    : 'denied'

  return {
    platform: 'darwin',
    screenRecording,
    accessibility,
    ready: screenRecording === 'granted' && accessibility === 'granted'
  }
}

export async function openScreenRecordingSettings(): Promise<void> {
  await shell.openExternal(SCREEN_RECORDING_PANE)
}

export async function openAccessibilitySettings(): Promise<void> {
  await shell.openExternal(ACCESSIBILITY_PANE)
}

/** Shows the one-time system prompt for Accessibility. Harmless if already granted. */
export function promptAccessibility(): boolean {
  if (process.platform !== 'darwin') return true
  return systemPreferences.isTrustedAccessibilityClient(true)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/main/permissions.test.ts`
Expected: PASS — 7 cases.

- [ ] **Step 5: Add the IPC handlers to `src/main/ipc.ts`**

Add the import:

```ts
import {
  getPermissionState,
  openAccessibilitySettings,
  openScreenRecordingSettings,
  promptAccessibility
} from './permissions'
```

and register:

```ts
  ipcMain.handle('permissions:get', () => getPermissionState())
  ipcMain.handle('permissions:open-screen', () => openScreenRecordingSettings())
  ipcMain.handle('permissions:open-accessibility', () => openAccessibilitySettings())
  ipcMain.handle('permissions:prompt-accessibility', () => promptAccessibility())
```

Also refuse to start hosting without the grants. At the top of the `host:start` handler, before `await stopHost()`:

```ts
    const permissions = getPermissionState()
    if (!permissions.ready) {
      throw new Error(
        'grant Screen Recording and Accessibility to RemoteDesk, then relaunch the app'
      )
    }
```

- [ ] **Step 6: Expose it in `src/preload/index.ts`**

```ts
  permissions: {
    get: () => ipcRenderer.invoke('permissions:get'),
    openScreen: () => ipcRenderer.invoke('permissions:open-screen'),
    openAccessibility: () => ipcRenderer.invoke('permissions:open-accessibility'),
    promptAccessibility: () => ipcRenderer.invoke('permissions:prompt-accessibility')
  },
```

- [ ] **Step 7: Write `src/renderer/ui/permission-gate.ts`**

```ts
interface PermissionState {
  platform: string
  screenRecording: 'granted' | 'denied' | 'not-determined' | 'not-needed'
  accessibility: 'granted' | 'denied' | 'not-determined' | 'not-needed'
  ready: boolean
}

/**
 * macOS blocks both screen capture and input injection until the user grants
 * them by hand, and a relaunch is required afterwards. This panel explains that
 * and re-checks on a timer so the state updates as soon as the user flips the
 * switches in System Settings.
 */
export class PermissionGate {
  readonly el: HTMLElement
  private timer: number | null = null

  constructor(private readonly onReadyChange: (ready: boolean) => void) {
    this.el = document.createElement('div')
    this.el.className = 'permission-gate'
    this.el.hidden = true
    this.el.innerHTML = `
      <h3>This Mac needs two permissions</h3>
      <ul>
        <li>
          <span id="pg-screen-state">checking…</span> Screen Recording
          <button id="pg-screen-open">Open settings</button>
        </li>
        <li>
          <span id="pg-access-state">checking…</span> Accessibility
          <button id="pg-access-open">Open settings</button>
        </li>
      </ul>
      <p class="hint">
        Enable RemoteDesk in both lists, then quit and reopen the app — macOS only
        applies these grants on relaunch.
      </p>
    `

    this.el.querySelector<HTMLButtonElement>('#pg-screen-open')!.onclick = () =>
      void window.rd.permissions.openScreen()
    this.el.querySelector<HTMLButtonElement>('#pg-access-open')!.onclick = () => {
      // Triggers the system prompt the first time, then opens the pane.
      void window.rd.permissions.promptAccessibility()
      void window.rd.permissions.openAccessibility()
    }
  }

  start(): void {
    void this.refresh()
    if (this.timer === null) {
      this.timer = window.setInterval(() => void this.refresh(), 2000)
    }
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
  }

  private async refresh(): Promise<void> {
    const state = (await window.rd.permissions.get()) as PermissionState
    if (state.platform !== 'darwin') {
      this.el.hidden = true
      this.onReadyChange(true)
      return
    }

    const mark = (status: string): string => (status === 'granted' ? '✅' : '⚠️')
    this.el.querySelector<HTMLElement>('#pg-screen-state')!.textContent = mark(
      state.screenRecording
    )
    this.el.querySelector<HTMLElement>('#pg-access-state')!.textContent = mark(state.accessibility)
    this.el.hidden = state.ready
    this.onReadyChange(state.ready)
  }
}
```

- [ ] **Step 8: Mount the gate in `src/renderer/ui/host-view.ts`**

Add the import:

```ts
import { PermissionGate } from './permission-gate'
```

Right after `const statusEl = ...`, insert:

```ts
  const gate = new PermissionGate((ready) => {
    startBtn.disabled = !ready || startBtn.dataset.running === 'true'
    if (!ready) setStatus('waiting for macOS permissions')
  })
  root.insertBefore(gate.el, select.parentElement)
  gate.start()
```

Mark the running state so the gate does not re-enable the button mid-session — in `startBtn.onclick`, after `startBtn.disabled = true`, add:

```ts
    startBtn.dataset.running = 'true'
```

and in `stopBtn.onclick`, before re-enabling:

```ts
    startBtn.dataset.running = 'false'
```

- [ ] **Step 9: Add styling to `src/renderer/styles.css`**

```css
.permission-gate {
  border: 1px solid #d1242f; border-radius: 8px; padding: 12px 16px;
}
.permission-gate h3 { margin: 0 0 8px; font-size: 14px; }
.permission-gate ul { margin: 0; padding-left: 18px; font-size: 13px; }
.permission-gate li { margin: 4px 0; }
.permission-gate .hint { font-size: 12px; opacity: 0.75; margin: 8px 0 0; }
```

- [ ] **Step 10: Manual verification**

On the Mac, revoke Screen Recording for Electron (System Settings → Privacy & Security → Screen Recording → toggle off), relaunch `npm run dev`, open *Share this machine*.
Expected: the red panel appears, *Start sharing* is disabled, and the ⚠️ next to Screen Recording turns ✅ within ~2 seconds of re-enabling it in System Settings. Re-grant and relaunch before continuing.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(M4): macOS permission detection and guided grant panel"
```

---

### Task 20: Host approval for incoming sessions

The PIN proves the caller knows the secret. It does not prove you want them on your desktop right now. This adds an explicit yes/no on the host.

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add the approval dialog to `src/main/ipc.ts`**

Add the helper above `registerIpc()`:

```ts
async function askHostToApprove(clientName: string): Promise<boolean> {
  const [win] = BrowserWindow.getAllWindows()
  if (!win) return false
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
```

and pass it to the server in the `host:start` handler:

```ts
      approveClient: askHostToApprove,
```

- [ ] **Step 2: Bring the window forward when a request arrives**

The dialog is useless behind other windows. In the same handler, wrap the approval so the window is shown first:

```ts
      approveClient: async (clientName) => {
        const [win] = BrowserWindow.getAllWindows()
        win?.show()
        win?.focus()
        return askHostToApprove(clientName)
      },
```

- [ ] **Step 3: Harden the window in `src/main/index.ts`**

Add navigation lockdown next to the existing `setWindowOpenHandler`, so a compromised renderer cannot be steered off-app:

```ts
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isDevServer =
      process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)
    if (!isDevServer && !url.startsWith('file://')) event.preventDefault()
  })

  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
```

- [ ] **Step 4: Verify and manually test**

```bash
npm run typecheck && npm test
```

Then connect from the client with the correct PIN.
Expected: the host window comes forward with an *Allow / Deny* dialog naming the client machine. *Deny* → the client reports "the host rejected the session" and no screen is shared. *Allow* → the session proceeds as before.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(M4): require host approval per session and lock down navigation"
```

---

### Task 21: Package installers for macOS and Windows

**Files:**
- Create: `electron-builder.yml`
- Create: `build/icon.png`
- Create: `.github/workflows/build.yml`
- Modify: `.gitignore`

- [ ] **Step 1: Add an app icon**

Put any square 1024×1024 PNG at `build/icon.png`. electron-builder derives the `.icns` and `.ico` from it. A placeholder is fine for testing:

```bash
mkdir -p build
# If you have no icon yet, generate a plain one:
python3 - <<'PY'
import struct, zlib
w = h = 1024
raw = b''.join(b'\x00' + bytes([30, 90, 160]) * w for _ in range(h))
def chunk(tag, data):
    body = tag + data
    return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body))
png = b'\x89PNG\r\n\x1a\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(raw, 9))
png += chunk(b'IEND', b'')
open('build/icon.png', 'wb').write(png)
PY
```

- [ ] **Step 2: Write `electron-builder.yml`**

```yaml
appId: com.keithnguyen.remotedesk
productName: RemoteDesk
copyright: Personal use only

directories:
  output: dist
  buildResources: build

files:
  - out/**
  - package.json

# nut.js ships a native .node binary; it must stay outside the asar archive.
asarUnpack:
  - '**/node_modules/@nut-tree-fork/**'

npmRebuild: true

mac:
  category: public.app-category.utilities
  icon: build/icon.png
  target:
    - target: dmg
      arch:
        - arm64
        - x64
  # No Developer ID certificate: skip signing entirely. The app is still usable
  # locally (right-click -> Open on first launch).
  identity: null
  hardenedRuntime: false
  gatekeeperAssess: false
  extendInfo:
    NSAppleEventsUsageDescription: >-
      RemoteDesk needs this to control this Mac during a remote session you approve.

win:
  icon: build/icon.png
  target:
    - target: nsis
      arch:
        - x64

nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
```

- [ ] **Step 3: Build the macOS installer locally**

```bash
npm run dist:mac
ls -la dist/*.dmg
```
Expected: `dist/RemoteDesk-0.1.0-arm64.dmg` (and an x64 dmg) exist.

- [ ] **Step 4: Install and verify the packaged Mac app**

```bash
open dist/
```

Drag RemoteDesk to Applications, then **right-click → Open** (Gatekeeper blocks a plain double-click on an unsigned app). Grant Screen Recording and Accessibility to *RemoteDesk* — these are separate from the grants you gave *Electron* in dev — and relaunch.

Optional, and recommended: ad-hoc sign the installed app so macOS keeps the permission grants stable across reinstalls:

```bash
codesign --force --deep --sign - /Applications/RemoteDesk.app
```

Expected: the packaged app hosts a session that the dev-mode client can connect to.

- [ ] **Step 5: Write `.github/workflows/build.yml`**

A Windows `.exe` cannot be produced on macOS, because nut.js installs a per-platform native binary. This matrix builds each installer on its own runner.

```yaml
name: build

on:
  workflow_dispatch:
  push:
    tags:
      - 'v*'

jobs:
  installers:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest
            script: dist:mac
            artifact: remotedesk-macos
            files: dist/*.dmg
          - os: windows-latest
            script: dist:win
            artifact: remotedesk-windows
            files: dist/*.exe
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - run: npm ci

      - run: npm test

      - run: npm run ${{ matrix.script }}
        env:
          # Never try to pick up a signing identity from the runner keychain.
          CSC_IDENTITY_AUTO_DISCOVERY: 'false'

      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.artifact }}
          path: ${{ matrix.files }}
          if-no-files-found: error
```

- [ ] **Step 6: Make sure the lockfile is committed (npm ci needs it)**

```bash
git status --short package-lock.json
git add package-lock.json
```

- [ ] **Step 7: Push and run the workflow**

```bash
git add -A
git commit -m "build: electron-builder config and CI installers for mac and windows"
git push -u origin HEAD
gh workflow run build
gh run watch
```

Expected: both jobs pass; the run page offers `remotedesk-macos` (`.dmg`) and `remotedesk-windows` (`.exe`) as downloadable artifacts.

If the Windows job fails inside `npm test`, the likely cause is the discovery test binding a UDP port the runner blocks. Skip those two files on CI rather than weakening them:

```ts
// tests/main/discovery.test.ts — add below the imports
const describeLocal = process.env.CI ? describe.skip : describe
// then use describeLocal(...) instead of describe(...)
```

- [ ] **Step 8: Verify the Windows installer end to end**

On a Windows machine: download the artifact, unzip, run the `.exe` → SmartScreen warning → *More info* → *Run anyway* → install → launch.
Expected: the Windows box can act as both host and client against the Mac, with no permission prompts.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "docs: note CI-only windows build path"
```

---

### Task 22: README with the operating instructions

The app has real setup steps that are not guessable. Write them down.

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# RemoteDesk

Personal remote-desktop app for macOS and Windows over a local network. One machine
shares its screen; the other views it, controls the mouse and keyboard, and exchanges
files, links and clipboard content.

## Install

Download the installer for your machine from the latest CI run, or build locally.

- **macOS** — open the `.dmg`, drag RemoteDesk to Applications, then **right-click the
  app → Open** the first time (it is unsigned, so a double-click is blocked).
- **Windows** — run the `.exe`. SmartScreen warns about an unknown publisher:
  *More info → Run anyway*.

## macOS permissions (host side only)

A Mac that will be *controlled* needs two grants in System Settings → Privacy & Security:

1. **Screen Recording** → RemoteDesk
2. **Accessibility** → RemoteDesk

The app shows a panel with buttons that jump to both panes. **Quit and reopen
RemoteDesk after granting** — macOS only applies these on relaunch.

Windows needs no permissions. Note that input cannot be injected into
UAC-elevated windows unless RemoteDesk itself runs as administrator.

## Use

On the machine you want to control:

1. Open the **Share this machine** tab.
2. Pick a screen and press **Start sharing**.
3. Read the 6-digit PIN. It changes every time you start sharing.

On the machine you are controlling from:

1. Open the **Control a machine** tab.
2. Press **Scan LAN** and pick the host, or type its IP address and port 45789.
3. Enter the PIN and press **Connect**.
4. The host approves the session in a dialog.
5. Tick **Take control of mouse & keyboard**, then click into the video.

Files: drag them onto the drop zone on either side. The receiving machine asks
where to save. Links: paste a URL and press **Send link**; the other machine asks
before opening it. Clipboard: copying on either machine updates the other.

## Network requirements

- Both machines on the same subnet.
- TCP 45789 (signaling) and UDP 45790 (discovery) reachable on the host.
- WebRTC picks its own UDP ports for the media and data streams.

Guest and corporate Wi-Fi often isolate clients from each other; if discovery finds
nothing, try a phone hotspot or type the IP manually to confirm.

## Security model

- The PIN is never transmitted. The client proves knowledge of it via an
  HMAC-SHA256 challenge–response, and the challenge is fresh per attempt.
- Screen video and all data channels are encrypted by WebRTC (DTLS-SRTP).
- One client at a time. The host approves each session, and can revoke mouse and
  keyboard control mid-session while still sharing the screen.
- Incoming links are restricted to `http`/`https` and always confirmed.
- Every message from the peer is validated before it can move a mouse or write a file.

This is a personal tool with no accounts, no telemetry and no relay server: it only
works between machines on the same LAN.

## Develop

```bash
npm install
npm run dev        # run the app
npm test           # unit and integration tests
npm run typecheck
npm run dist:mac   # .dmg (macOS only)
npm run dist:win   # .exe (Windows only — see below)
```

A Windows installer cannot be built on macOS: nut.js installs a native binary for
the host platform only. Use the GitHub Actions `build` workflow, which builds both
installers on their own runners.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README with install, permissions and usage"
```

---

## Out of scope — the next plan

Write a second plan, `docs/superpowers/plans/<date>-remotedesk-internet.md`, only after
M4 is working on both machines. It covers:

- A signaling server (Node + `ws` on a small VPS) that pairs machines by a stable ID
  instead of an IP address, so the two peers never need to be on the same network.
- A TURN server (coturn) for the cases where NAT hole-punching fails, plus the
  `iceServers` configuration in `src/renderer/rtc/peer.ts` that this plan leaves empty.
- Long-lived device identity and pairing, replacing the per-session PIN with a stored
  key pair, since a 6-digit PIN is not enough once the host is reachable from the
  internet.
- TLS on the signaling connection (`wss://`), which LAN-only mode does not need.

Keeping it separate matters: the LAN version is useful on its own and is the thing
that proves capture, injection and the data channels work before any server exists.

---

## Self-Review

Checked after writing, against the agreed requirements.

**Spec coverage**

| Requirement | Task |
|---|---|
| Remote screen viewing | 7, 9, 10 |
| Mouse and keyboard control | 11, 12, 13, 14 |
| File and image sharing | 15, 16 |
| Sending links | 17 |
| Clipboard sync | 18 |
| LAN first | 4, 5, 6 — no external server anywhere in this plan |
| Internet later | deliberately deferred, scoped above |
| Light and simple | plain TS renderer, no UI framework; four runtime dependencies total |
| macOS + Windows installers | 21 (local `.dmg`, CI for both) |
| Works on both OSes | 13 and 19 carry the per-platform branches |

**Type consistency** — names used across tasks line up: `InputMessage` / `CtrlMessage` /
`SignalMessage` (Task 2) are consumed unchanged in 13, 16 and 18; `ClipSnapshot` (18) is
the same shape in `clipboard.ts`, the preload API and both views; `session.channel('ctrl')`
returns `RTCDataChannel | undefined` in both session classes, which is what `TransferPanel`
expects; `setInputEnabled` is async in both its definition (13) and its IPC use (14).

**Known ordering wrinkle, resolved in place** — `TransferPanel` (Task 16) imports
`url-guard` (Task 17) and calls `window.rd.clipboard` (Task 18). The plan writes the
complete file once in Task 16 and defers the full typecheck to Task 18 Step 9, which is
called out explicitly in both places. The alternative — writing the file three times —
would be worse for whoever executes this.

**Deliberate non-TDD tasks** — 1, 7, 8, 9, 10, 14, 16, 19 (steps 5–9), 20, 21, 22 touch
Electron, the real OS input stack, live media or packaging, none of which a unit test can
meaningfully assert. Each ends with a concrete manual verification with expected results
and troubleshooting, instead of a fake test. Everything with real logic in it — the wire
protocol, auth, signaling, discovery, coordinates, key mapping, injection translation,
chunking, URL validation and clipboard dedupe — is TDD with tests written first.
