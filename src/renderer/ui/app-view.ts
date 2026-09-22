import { ClientSession } from '../rtc/client-session'
import { HostSession } from '../rtc/host-session'
import { PermissionGate } from './permission-gate'
import { RemoteScreen } from './remote-screen'
import { SharesPanel } from './shares-panel'
import { TransferPanel } from './transfer-panel'

interface Identity {
  token: string
  formatted: string
  machineName: string
  platform: string
}

interface PermissionState {
  platform: string
  screenRecording: 'granted' | 'denied' | 'not-determined' | 'not-needed'
  accessibility: 'granted' | 'denied' | 'not-determined' | 'not-needed'
  ready: boolean
}

interface ScreenChoice {
  id: string
  name: string
  thumbnailDataUrl: string
}

/**
 * One screen for both directions: this machine always shows its own ID and is
 * always reachable, and the same screen takes a partner's ID to connect out.
 */
export function createAppView(): HTMLElement {
  const root = document.createElement('div')
  root.className = 'app'
  root.innerHTML = `
    <div class="layout">
      <div class="main-col">
        <section class="card" id="identity-card">
          <h2>Your ID</h2>
          <p class="hint">Send this to the other machine. It stays the same until you regenerate it.</p>
          <div class="row id-row">
            <code class="token" id="my-token">---- ---- ----</code>
            <button id="copy-id">Copy</button>
            <button id="regen-id" class="secondary">Regenerate</button>
            <span class="copied" id="copied-flag" hidden>copied</span>
          </div>
          <p class="status" id="listen-status">starting...</p>
        </section>

        <section class="card">
          <h2>Internet (optional)</h2>
          <p class="hint">
            LAN connections always try first. Add a relay server so you can also
            connect from anywhere - a different city, a different country -
            with no port forwarding on either end.
          </p>
          <div class="row">
            <input
              id="relay-url"
              placeholder="wss://relay.example.com"
              autocomplete="off"
              spellcheck="false"
            />
            <button id="relay-save">Save</button>
          </div>
          <p class="status" id="relay-status">not configured - LAN only</p>
        </section>

        <section class="card">
          <h2>Connect to a machine</h2>
          <p class="hint">Paste the ID the other machine is showing.</p>
          <div class="row">
            <input id="peer-token" placeholder="1234 5678 9012" autocomplete="off" spellcheck="false" />
            <button id="connect">Connect</button>
            <button id="disconnect" class="secondary" disabled>Disconnect</button>
          </div>
          <label class="row">
            <input type="checkbox" id="take-control" disabled />
            Take control of their mouse and keyboard
          </label>
          <p class="status" id="session-status">idle</p>
        </section>

        <section class="card" id="sharing-card">
          <h2>When someone connects to you</h2>
          <label class="row">Share screen <select id="screen-select"></select></label>
          <label class="row">
            <input type="checkbox" id="allow-control" checked />
            Let them control my mouse and keyboard
          </label>
          <p class="status" id="incoming-status">nobody connected</p>
        </section>
      </div>
      <div class="shares-col"></div>
    </div>
  `

  const tokenEl = root.querySelector<HTMLElement>('#my-token')!
  const copyBtn = root.querySelector<HTMLButtonElement>('#copy-id')!
  const regenBtn = root.querySelector<HTMLButtonElement>('#regen-id')!
  const copiedFlag = root.querySelector<HTMLElement>('#copied-flag')!
  const listenStatus = root.querySelector<HTMLElement>('#listen-status')!
  const relayUrlInput = root.querySelector<HTMLInputElement>('#relay-url')!
  const relaySaveBtn = root.querySelector<HTMLButtonElement>('#relay-save')!
  const relayStatus = root.querySelector<HTMLElement>('#relay-status')!
  const peerInput = root.querySelector<HTMLInputElement>('#peer-token')!
  const connectBtn = root.querySelector<HTMLButtonElement>('#connect')!
  const disconnectBtn = root.querySelector<HTMLButtonElement>('#disconnect')!
  const takeControl = root.querySelector<HTMLInputElement>('#take-control')!
  const sessionStatus = root.querySelector<HTMLElement>('#session-status')!
  const screenSelect = root.querySelector<HTMLSelectElement>('#screen-select')!
  const allowControl = root.querySelector<HTMLInputElement>('#allow-control')!
  const incomingStatus = root.querySelector<HTMLElement>('#incoming-status')!
  const sharingCard = root.querySelector<HTMLElement>('#sharing-card')!

  let transfer: TransferPanel | null = null
  const shares = new SharesPanel()

  const setSessionStatus = (text: string): void => {
    sessionStatus.textContent = text
  }
  const setIncomingStatus = (text: string): void => {
    incomingStatus.textContent = text
  }

  // --- outgoing: we are viewing them ---
  const clientSession = new ClientSession({
    onStatus: setSessionStatus,
    onStream: (stream) => {
      screen.setStream(stream)
      screen.el.hidden = false
      takeControl.disabled = false
    },
    onCtrlMessage: (raw) => transfer?.handleCtrl(raw),
    onFileChunk: (chunk) => transfer?.handleChunk(chunk)
  })

  const screen = new RemoteScreen({ send: (msg) => clientSession.sendInput(msg) })
  screen.el.hidden = true

  // --- incoming: they are viewing us ---
  const hostSession = new HostSession({
    onStatus: setIncomingStatus,
    onInputMessage: (raw) => void window.rd.input.apply(raw),
    onCtrlMessage: (raw) => transfer?.handleCtrl(raw),
    onFileChunk: (chunk) => transfer?.handleChunk(chunk)
  })

  /** Only one session is live at a time, so file/link/clipboard traffic follows it. */
  const activeChannels = (): { ctrl?: RTCDataChannel; file?: RTCDataChannel } => {
    const outCtrl = clientSession.channel('ctrl')
    if (outCtrl) return { ctrl: outCtrl, file: clientSession.channel('file') }
    return { ctrl: hostSession.channel('ctrl'), file: hostSession.channel('file') }
  }

  transfer = new TransferPanel({
    channels: activeChannels,
    onSharedText: (text) => shares.addText(text),
    onSharedLink: (url) => shares.addLink(url),
    onSharedImage: (dataUrl) => shares.addImage(dataUrl),
    onSharedFile: (name, path) => shares.addFile(name, path)
  })

  const gate = new PermissionGate((ready) => {
    sharingCard.classList.toggle('blocked', !ready)
  })

  const mainCol = root.querySelector<HTMLElement>('.main-col')!
  const sharesCol = root.querySelector<HTMLElement>('.shares-col')!
  root.querySelector<HTMLElement>('#identity-card')!.after(gate.el)
  mainCol.append(screen.el, transfer.el)
  sharesCol.append(shares.el)
  gate.start()

  // --- identity ---
  void window.rd.identity.get().then((value) => {
    const id = value as Identity
    tokenEl.textContent = id.formatted
    listenStatus.textContent = `${id.machineName} (${id.platform}) - reachable on this network`
  })

  copyBtn.onclick = async () => {
    await window.rd.identity.copy()
    copiedFlag.hidden = false
    setTimeout(() => {
      copiedFlag.hidden = true
    }, 1500)
  }

  regenBtn.onclick = async () => {
    const value = (await window.rd.identity.regenerate()) as { formatted: string }
    tokenEl.textContent = value.formatted
    listenStatus.textContent = 'new ID - anyone holding the old one can no longer connect'
  }

  // --- internet relay (optional) ---
  void window.rd.relay.get().then((value) => {
    const { url } = value as { url: string | null }
    if (url) {
      relayUrlInput.value = url
      relayStatus.textContent = `configured: ${url}`
    }
  })

  relaySaveBtn.onclick = async () => {
    relaySaveBtn.disabled = true
    const url = relayUrlInput.value.trim() || null
    try {
      const result = (await window.rd.relay.set(url)) as { url: string | null }
      relayStatus.textContent = result.url
        ? `configured: ${result.url} - connecting...`
        : 'not configured - LAN only'
    } finally {
      relaySaveBtn.disabled = false
    }
  }

  window.rd.relay.onStatus((payload) => {
    const { text } = payload as { text: string }
    relayStatus.textContent = relayUrlInput.value.trim() ? text : 'not configured - LAN only'
  })

  // --- screens ---
  void window.rd.screens.list().then((value) => {
    const list = value as ScreenChoice[]
    screenSelect.innerHTML = list.map((s) => `<option value="${s.id}">${s.name}</option>`).join('')
    if (list[0]) void window.rd.screens.select(list[0].id)
  })
  screenSelect.onchange = () => void window.rd.screens.select(screenSelect.value)

  allowControl.onchange = () => void window.rd.input.setEnabled(allowControl.checked)
  takeControl.onchange = () => screen.setControlEnabled(takeControl.checked)

  // --- connecting out ---
  const resetOutgoing = (reason: string): void => {
    clientSession.stop()
    screen.clear()
    screen.el.hidden = true
    transfer?.reset()
    takeControl.checked = false
    takeControl.disabled = true
    void window.rd.clipboard.watch(false)
    setSessionStatus(reason)
    disconnectBtn.disabled = true
    connectBtn.disabled = false
  }

  connectBtn.onclick = async () => {
    connectBtn.disabled = true
    setSessionStatus('looking for that ID, then waiting for them to allow...')
    try {
      // session:connect only resolves once the host has already approved -
      // SignalingClient.attach() waits for 'auth-ok', which the host sends
      // AFTER the Allow/Deny dialog resolves to Allow. So by the time this
      // continuation runs, approval already happened; window.rd.client.
      // onConnected (fired moments earlier, inside that same approval) is
      // the accurate status from here on - this handler must not overwrite
      // it with stale "waiting for them to allow" text.
      await window.rd.session.connect(peerInput.value)
      disconnectBtn.disabled = false
    } catch (err) {
      setSessionStatus((err as Error).message)
      connectBtn.disabled = false
    }
  }

  disconnectBtn.onclick = async () => {
    await window.rd.session.disconnect()
    resetOutgoing('idle')
  }

  window.rd.client.onConnected((payload) => {
    const { hostName } = payload as { hostName: string }
    setSessionStatus(`connected to ${hostName} - waiting for their screen`)
    void window.rd.clipboard.watch(true)
  })

  window.rd.client.onClosed((payload) => {
    const { reason } = payload as { reason: string }
    resetOutgoing(`disconnected: ${reason}`)
  })

  // Never leave these as bare `void`: handleSignal awaits setRemoteDescription,
  // createAnswer and IPC, and a rejection swallowed here means no answer is
  // ever sent and the peer waits forever with nothing on screen to say why.
  window.rd.client.onSignal((msg) => {
    clientSession.handleSignal(msg).catch((err: Error) => {
      setSessionStatus(`connection failed: ${err.message}`)
    })
  })

  // --- being connected to ---
  window.rd.host.onClientJoined(async (payload) => {
    const { clientName } = payload as { clientName: string }
    setIncomingStatus(`${clientName} connected - sharing screen`)

    // Try first, explain afterwards. Capture failing is the only thing that
    // actually matters, and the reported permission state is not a reliable
    // predictor of it - 'not-determined' also covers "no TCC record yet", where
    // capture may well succeed. Gating on it would refuse sessions that work.
    // What the state is good for is translating getDisplayMedia's useless
    // "Invalid capture constraints" into something actionable, and telling the
    // peer too, so they are not left waiting on a screen that is never coming.
    try {
      await hostSession.start()
      await window.rd.input.setEnabled(allowControl.checked)
      await window.rd.clipboard.watch(true)
    } catch (err) {
      const message = (err as Error).message
      const permissions = (await window.rd.permissions.get()) as PermissionState
      const denied =
        permissions.screenRecording !== 'granted' && permissions.screenRecording !== 'not-needed'

      // Release the capture this attempt may already have acquired before
      // failing later on - abortSession alone would leave it running.
      hostSession.stop()

      setIncomingStatus(
        denied
          ? 'could not share the screen: Screen Recording is not granted. ' +
              'Enable RemoteDesk in System Settings > Privacy & Security > Screen Recording, ' +
              'then quit and reopen this app.'
          : `could not share the screen: ${message}`
      )
      await window.rd.host.abortSession(
        denied
          ? 'the other machine has not granted Screen Recording'
          : `the other machine could not share its screen (${message})`
      )
    }
  })

  window.rd.host.onClientLeft(() => {
    hostSession.stop()
    transfer?.reset()
    void window.rd.clipboard.watch(false)
    setIncomingStatus('nobody connected')
  })

  window.rd.host.onSignal((msg) => {
    hostSession.handleSignal(msg).catch((err: Error) => {
      setIncomingStatus(`connection failed: ${err.message}`)
    })
  })

  // Local clipboard changes go out on whichever session is live; incoming ones
  // are applied by TransferPanel.handleCtrl.
  window.rd.clipboard.onLocalChange((snapshot) => {
    const ctrl = activeChannels().ctrl
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

  return root
}
