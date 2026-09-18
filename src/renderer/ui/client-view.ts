import { ClientSession } from '../rtc/client-session'
import { RemoteScreen } from './remote-screen'
import { TransferPanel } from './transfer-panel'

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
      <select id="cl-hosts"><option value="">- no hosts found -</option></select>
    </div>
    <div class="row">
      <input id="cl-address" placeholder="192.168.1.20" />
      <input id="cl-port" value="45789" size="6" />
      <input id="cl-pin" placeholder="PIN" maxlength="6" size="8" />
      <button id="cl-connect">Connect</button>
      <button id="cl-disconnect" disabled>Disconnect</button>
    </div>
    <label class="row">
      <input type="checkbox" id="cl-control" />
      Take control of mouse and keyboard
    </label>
    <p class="status" id="cl-status">idle</p>
  `

  const scanBtn = root.querySelector<HTMLButtonElement>('#cl-scan')!
  const hostsSel = root.querySelector<HTMLSelectElement>('#cl-hosts')!
  const addressInput = root.querySelector<HTMLInputElement>('#cl-address')!
  const portInput = root.querySelector<HTMLInputElement>('#cl-port')!
  const pinInput = root.querySelector<HTMLInputElement>('#cl-pin')!
  const connectBtn = root.querySelector<HTMLButtonElement>('#cl-connect')!
  const disconnectBtn = root.querySelector<HTMLButtonElement>('#cl-disconnect')!
  const controlToggle = root.querySelector<HTMLInputElement>('#cl-control')!
  const statusEl = root.querySelector<HTMLElement>('#cl-status')!

  let session: ClientSession | null = null
  let transfer: TransferPanel | null = null

  const setStatus = (text: string): void => {
    statusEl.textContent = text
  }

  const screen = new RemoteScreen({
    send: (msg) => session?.sendInput(msg)
  })

  session = new ClientSession({
    onStatus: setStatus,
    onStream: (stream) => screen.setStream(stream),
    onCtrlMessage: (raw) => transfer?.handleCtrl(raw),
    onFileChunk: (chunk) => transfer?.handleChunk(chunk)
  })

  const liveSession = session

  transfer = new TransferPanel({
    channels: () => ({ ctrl: liveSession.channel('ctrl'), file: liveSession.channel('file') })
  })

  root.append(screen.el, transfer.el)

  const teardown = (reason: string): void => {
    liveSession.stop()
    screen.clear()
    transfer?.reset()
    controlToggle.checked = false
    void window.rd.clipboard.watch(false)
    setStatus(reason)
    disconnectBtn.disabled = true
    connectBtn.disabled = false
  }

  scanBtn.onclick = async () => {
    setStatus('scanning...')
    const hosts = (await window.rd.client.discover()) as DiscoveredHost[]
    hostsSel.innerHTML = hosts.length
      ? hosts
          .map(
            (h) =>
              `<option value="${h.address}:${h.port}">${h.hostName} (${h.address}) - ${h.platform}</option>`
          )
          .join('')
      : '<option value="">- no hosts found -</option>'
    setStatus(`${hosts.length} host(s) found`)
    hostsSel.dispatchEvent(new Event('change'))
  }

  hostsSel.onchange = () => {
    const [address, port] = hostsSel.value.split(':')
    if (address) addressInput.value = address
    if (port) portInput.value = port
  }

  controlToggle.onchange = () => screen.setControlEnabled(controlToggle.checked)

  connectBtn.onclick = async () => {
    connectBtn.disabled = true
    setStatus('connecting...')
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
    await window.rd.client.disconnect()
    teardown('idle')
  }

  window.rd.client.onConnected((payload) => {
    const { hostName } = payload as { hostName: string }
    setStatus(`connected to ${hostName} - waiting for screen`)
    void window.rd.clipboard.watch(true)
  })

  window.rd.client.onClosed((payload) => {
    const { reason } = payload as { reason: string }
    teardown(`disconnected: ${reason}`)
  })

  window.rd.client.onSignal((msg) => void liveSession.handleSignal(msg))

  // Local clipboard changes go out on the ctrl channel; incoming ones are
  // applied by TransferPanel.handleCtrl.
  window.rd.clipboard.onLocalChange((snapshot) => {
    const ctrl = liveSession.channel('ctrl')
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
