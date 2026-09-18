import { HostSession } from '../rtc/host-session'
import { PermissionGate } from './permission-gate'
import { TransferPanel } from './transfer-panel'

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
    <label class="row">Screen <select id="host-screen"></select></label>
    <div class="row">
      <button id="host-start">Start sharing</button>
      <button id="host-stop" disabled>Stop</button>
    </div>
    <p class="pin">PIN: <strong id="host-pin">------</strong></p>
    <label class="row">
      <input type="checkbox" id="host-allow-input" checked />
      Allow this client to control my mouse and keyboard
    </label>
    <p class="status" id="host-status">idle</p>
  `

  const select = root.querySelector<HTMLSelectElement>('#host-screen')!
  const startBtn = root.querySelector<HTMLButtonElement>('#host-start')!
  const stopBtn = root.querySelector<HTMLButtonElement>('#host-stop')!
  const pinEl = root.querySelector<HTMLElement>('#host-pin')!
  const statusEl = root.querySelector<HTMLElement>('#host-status')!
  const allowInput = root.querySelector<HTMLInputElement>('#host-allow-input')!

  let running = false
  let transfer: TransferPanel | null = null

  const setStatus = (text: string): void => {
    statusEl.textContent = text
  }

  const session = new HostSession({
    onStatus: setStatus,
    onInputMessage: (raw) => void window.rd.input.apply(raw),
    onCtrlMessage: (raw) => transfer?.handleCtrl(raw),
    onFileChunk: (chunk) => transfer?.handleChunk(chunk)
  })

  transfer = new TransferPanel({
    channels: () => ({ ctrl: session.channel('ctrl'), file: session.channel('file') })
  })

  const gate = new PermissionGate((ready) => {
    startBtn.disabled = running || !ready
    if (!ready && !running) setStatus('waiting for macOS permissions')
  })
  root.prepend(gate.el)
  root.append(transfer.el)
  gate.start()

  void window.rd.screens.list().then((screens) => {
    const list = screens as ScreenChoice[]
    select.innerHTML = list.map((s) => `<option value="${s.id}">${s.name}</option>`).join('')
    if (list[0]) void window.rd.screens.select(list[0].id)
  })

  select.onchange = () => void window.rd.screens.select(select.value)

  allowInput.onchange = () => void window.rd.input.setEnabled(allowInput.checked)

  startBtn.onclick = async () => {
    startBtn.disabled = true
    running = true
    try {
      const result = (await window.rd.host.start()) as { pin: string; port: number }
      pinEl.textContent = result.pin
      setStatus(`listening on port ${result.port} - waiting for a client`)
      stopBtn.disabled = false
    } catch (err) {
      running = false
      setStatus(`failed to start: ${(err as Error).message}`)
      startBtn.disabled = false
    }
  }

  stopBtn.onclick = async () => {
    session.stop()
    transfer?.reset()
    await window.rd.clipboard.watch(false)
    await window.rd.host.stop()
    pinEl.textContent = '------'
    setStatus('idle')
    running = false
    stopBtn.disabled = true
    startBtn.disabled = false
  }

  window.rd.host.onClientJoined(async (payload) => {
    const { clientName } = payload as { clientName: string }
    setStatus(`${clientName} connected - capturing screen`)
    try {
      await session.start()
      await window.rd.input.setEnabled(allowInput.checked)
      await window.rd.clipboard.watch(true)
    } catch (err) {
      setStatus(`capture failed: ${(err as Error).message}`)
    }
  })

  window.rd.host.onClientLeft(() => {
    session.stop()
    transfer?.reset()
    void window.rd.clipboard.watch(false)
    setStatus('client left - waiting')
  })

  window.rd.host.onSignal((msg) => void session.handleSignal(msg))

  // Local clipboard changes go out on the ctrl channel; incoming ones are
  // applied by TransferPanel.handleCtrl.
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

  return root
}
