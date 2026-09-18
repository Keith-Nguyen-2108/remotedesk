# RemoteDesk

Personal remote-desktop app for macOS and Windows over a local network. One machine
shares its screen; the other views it, controls the mouse and keyboard, and exchanges
files, links and clipboard content.

No accounts, no telemetry, no relay server — it works between machines on the same LAN.

## Install

- **macOS** — open the `.dmg`, drag RemoteDesk to Applications, then **right-click the
  app → Open** the first time. A plain double-click is blocked because the app is
  unsigned.
- **Windows** — run `RemoteDesk Setup 0.1.0.exe`. SmartScreen warns about an unknown
  publisher: *More info → Run anyway*.

## macOS permissions (only needed on the machine being controlled)

A Mac that will be *controlled* needs two grants in System Settings → Privacy & Security:

1. **Screen Recording** → RemoteDesk
2. **Accessibility** → RemoteDesk

The app shows a panel with buttons that jump straight to both panes, and *Start sharing*
stays disabled until both are granted. **Quit and reopen RemoteDesk after granting** —
macOS only applies these on relaunch.

Dev mode and the packaged app are separate binaries as far as macOS is concerned, so
each needs its own grant (*Electron* in dev, *RemoteDesk* when installed).

Windows needs no permissions. One limitation: input cannot be injected into
UAC-elevated windows unless RemoteDesk itself runs as administrator.

## Use

On the machine you want to control:

1. Open the **Share this machine** tab.
2. Pick a screen and press **Start sharing**.
3. Read the 6-digit PIN. It is regenerated every time you start sharing.

On the machine you are controlling from:

1. Open the **Control a machine** tab.
2. Press **Scan LAN** and pick the host, or type its IP address and port 45789.
3. Enter the PIN and press **Connect**.
4. The host gets an *Allow / Deny* dialog naming your machine.
5. Tick **Take control of mouse and keyboard**, then click into the video.

The host can untick **Allow this client to control my mouse and keyboard** at any point
to revoke control while still sharing the screen.

**Files and images** — drag onto the drop zone on either side; the receiver picks where
to save. **Links** — paste a URL and press *Send link*; the other machine asks before
opening it. **Clipboard** — copying on either machine updates the other automatically.

## Network requirements

- Both machines on the same subnet.
- On the host: TCP 45789 (signaling) and UDP 45790 (discovery) reachable.
- WebRTC negotiates its own UDP ports for the video and data streams.

Guest and corporate Wi-Fi often isolate clients from each other. If **Scan LAN** finds
nothing, type the host's IP manually, or test over a phone hotspot.

## Security model

- The PIN is never transmitted. The client proves it knows the PIN with an HMAC-SHA256
  challenge–response, and the challenge is freshly random per attempt, so a listener
  learns nothing reusable.
- Screen video and all three data channels are encrypted by WebRTC (DTLS-SRTP).
- One client at a time, and the host approves each session by hand.
- Incoming links are restricted to `http`/`https`, rejected if they carry embedded
  credentials, and always confirmed in a dialog before opening.
- Received files are written only through a Save dialog, and the proposed filename is
  reduced to its basename so a peer cannot suggest a path.
- Every message from the peer is validated before it can move a mouse or write a file;
  malformed frames are dropped, not trusted.
- Disabling control releases any keys or buttons the peer was holding, so a disconnect
  mid-drag cannot leave a modifier stuck down.

## Develop

```bash
npm install
npm run dev        # run the app with hot reload
npm test           # 102 unit and integration tests
npm run typecheck
npm run dist:mac   # builds both arm64 and x64 .dmg
npm run dist:win   # builds the .exe
```

Both installers build on macOS. This works because `@nut-tree-fork/nut-js` ships its
native binary as one package per platform (`libnut-darwin`, `libnut-win32`,
`libnut-linux`) and npm installs all three regardless of host OS, so the Windows build
gets a genuine PE32+ `libnut.node`. The macOS-only permission shim it also bundles is
loaded inside a try/catch and short-circuits when `process.platform !== 'darwin'`.

The `.exe` produced this way has not been exercised on real Windows hardware. The
`build` GitHub Actions workflow builds each installer on its own runner
(`workflow_dispatch`, or push a `v*` tag) if you want native-built artifacts.

### Layout

| Path | Responsibility |
|---|---|
| `src/shared/` | Pure logic, no Electron import — protocol, auth, coords, keymap, chunking, clipboard dedupe, URL guard |
| `src/main/` | Electron main — signaling server/client, UDP discovery, nut.js injection, capture, permissions, IPC |
| `src/preload/` | The single `contextBridge` API the renderer may call |
| `src/renderer/` | UI and the WebRTC sessions |
| `tests/` | Vitest; `tests/main/signaling.test.ts` and `discovery.test.ts` use real sockets |

The implementation plan this was built from is in
`docs/superpowers/plans/2026-09-18-remotedesk-lan-mvp.md`.

## Not included

Internet connections, ID-based pairing and a TURN relay are deliberately out of scope —
this version is LAN-only. Also absent: audio, multi-monitor viewing, multiple concurrent
clients, unattended access and signed installers.
