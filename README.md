# RemoteDesk

Personal remote-desktop app for macOS and Windows. One machine shares its screen; the
other views it, controls the mouse and keyboard, and exchanges files, links and
clipboard content.

No accounts, no telemetry. Two machines on the same network find and connect to each
other directly, no server involved. Reaching a machine on a *different* network -
another city, another country - needs one small relay server standing between them
(see "Connecting from anywhere" below) - it only ever introduces the two machines and
never sees your screen, keystrokes, or files, which still travel directly between them.

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

Both machines run the same screen and do the same two things.

**1. Swap IDs.** Each machine shows its own 12-digit **ID** at the top, e.g.
`4821 0937 5566`. Press **Copy** and send it to the other person however you like —
chat, email, a phone photo. The ID is stable across restarts; press **Regenerate**
to mint a new one, which instantly stops anyone holding the old one from connecting.

**2. Paste and connect.** Put the partner's ID into *Connect to a machine* and press
**Connect**. Their machine shows an **Allow / Deny** dialog naming yours. Once they
allow, their screen appears. Tick **Take control of their mouse and keyboard** and
click into the video to drive it.

On the same network this is all there is to it. Reaching a machine on a different
network needs the **Internet (optional)** card filled in on both sides first - see
"Connecting from anywhere" further down.

There is no separate "host mode" to start: every machine listens from the moment it
opens, so whoever has your ID can reach you. The *When someone connects to you*
section picks which screen you share and can revoke their mouse and keyboard at any
time while still showing your screen.

**Files and images** — drag onto the drop zone; the receiver picks where to save.
**Links** — paste a URL and press *Send link*; the other machine asks before opening
it. **Clipboard** — copying on either machine updates the other automatically.

## Network requirements

**Same network (default, no setup):**
- Both machines on the same subnet.
- UDP 45790 (ID lookup) and TCP 45789 (signaling) reachable.
- WebRTC negotiates its own UDP ports for the video and data streams.

Guest and corporate Wi-Fi often isolate clients from each other, which stops the ID
lookup from reaching anyone. If Connect reports that nobody answered on the LAN and no
relay is configured, test the two machines over a phone hotspot.

**Different networks - different cities, different countries:** LAN discovery physically
cannot cross the internet (broadcast packets don't leave the local network, and home
routers have no public address to be reached at). For that, configure a relay server -
see "Connecting from anywhere" below. Once one is set up, Connect tries the LAN first
and only falls back to the relay when nothing answers locally, so nothing changes for
same-network use.

## Security model

- **The ID is the secret, and it never travels.** Looking up an ID broadcasts
  `HMAC-SHA256(id, nonce)` with a fresh random nonce, so only the machine that
  already holds that ID can recognise the request — everyone else stays silent, and
  a sniffer on the LAN learns nothing reusable. The signalling handshake then proves
  knowledge of the ID the same way. At no point is the ID itself put on the wire.
- Regenerating an ID takes effect immediately, including for a lookup that has
  already resolved but not yet connected.
- Screen video and all three data channels are encrypted by WebRTC (DTLS-SRTP).
- One connection at a time, and the receiving machine approves each one by hand:
  knowing the ID gets you as far as the dialog, not onto the desktop.
- The optional relay server (for connecting across networks) only ever sees
  `SHA-256(id)`, never the ID itself, and only forwards opaque bytes once two
  machines are paired - it cannot read screen data, keystrokes, or files, and
  cannot authenticate as either side. See `server/src/relay-server.ts`.
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
npm test           # 139 unit and integration tests
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
| `src/main/` | Electron main — signaling server/client, UDP discovery, internet relay client, nut.js injection, capture, permissions, IPC |
| `src/preload/` | The single `contextBridge` API the renderer may call |
| `src/renderer/` | UI and the WebRTC sessions |
| `server/` | The standalone internet relay server — its own package, deployed separately from the app |
| `tests/` | Vitest; `signaling`, `discovery`, `connect-flow`, `relay-server` and `relay-connect-flow` tests use real sockets, no mocks |

The implementation plan this was built from is in
`docs/superpowers/plans/2026-09-18-remotedesk-lan-mvp.md`.

## Connecting from anywhere (internet mode)

LAN discovery cannot reach a machine on a different network - there is no server to
ask "where is this ID" once the two machines aren't on the same broadcast domain. Every
"connect from anywhere" tool solves this the same way: a small public server that both
machines connect *out* to (an outbound connection passes through any home/mobile NAT or
firewall with no configuration), which introduces them and then gets out of the way -
the actual screen/control traffic still goes directly peer-to-peer via WebRTC.

That server is `server/` in this repo - see `server/README.md` for what it does and how
to deploy it (Docker, or a platform like Fly.io with a free tier). It's a small, mostly
idle process; a few dollars a month of the cheapest VPS you can find is enough. Once
it's deployed:

1. Open RemoteDesk on **both** machines.
2. Under **Internet (optional)**, paste the relay's `wss://` URL and press Save.
3. Connect by ID exactly as before. LAN is always tried first; the relay only kicks in
   when nothing answers on the local network - so this changes nothing for two
   machines already on the same Wi-Fi.

This repository does not include a deployed relay - only the code for one and a guide
to stand it up, since that step needs hosting you control (a VPS, or an account with a
platform like Fly.io/Render). Everything on the app side (the relay client, the STUN
servers WebRTC needs to get through most NATs once signaling succeeds, the settings UI)
is implemented and tested against a real running relay server - see
`tests/server/relay-server.test.ts` and `tests/main/relay-connect-flow.test.ts`.

## Not included

No TURN relay: STUN (built in, free, no server needed) gets most home and mobile
connections through directly once the relay above has done the signaling handshake. A
minority of networks - symmetric NAT, some corporate firewalls - need a TURN relay as a
last resort, which does carry real video/control bandwidth and therefore real hosting
cost; see the note at the bottom of `server/README.md` if you hit that case.

Also absent: audio, multi-monitor viewing, multiple concurrent clients, unattended
access, and signed installers.
