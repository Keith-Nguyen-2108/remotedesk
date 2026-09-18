import { parseCtrlMessage, parseJson } from '../../shared/protocol'
import { imageDataUrlSubtype } from '../../shared/shares'
import { normalizeExternalUrl } from '../../shared/url-guard'
import { FileReceiver, sendFile } from '../rtc/file-transfer'

export interface TransferPanelPorts {
  /** Returns the live data channels, or undefined when not connected. */
  channels: () => { ctrl?: RTCDataChannel; file?: RTCDataChannel }
  /** A share arrived from the peer - hand it to the Shares panel, don't act on it here. */
  onSharedText: (text: string) => void
  onSharedLink: (url: string) => void
  onSharedImage: (dataUrl: string) => void
  onSharedFile: (name: string, path: string) => void
}

const MAX_LOG_LINES = 40

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
        <input type="text" id="tp-link" placeholder="https://... send a link" />
        <button id="tp-send-link">Send link</button>
      </div>
      <ul class="log" id="tp-log"></ul>
    `
    this.log = this.el.querySelector<HTMLElement>('#tp-log')!

    this.receiver = new FileReceiver({
      onProgress: (name, progress) =>
        this.say(`receiving ${name} - ${Math.round(progress * 100)}%`, true),
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
      this.ports.onSharedLink(msg.url)
      this.say('link received - see Shares')
    } else if (msg.t === 'clip-text') {
      this.ports.onSharedText(msg.text)
      this.say(`text received (${msg.text.length} chars) - see Shares`)
    } else if (msg.t === 'clip-image') {
      if (imageDataUrlSubtype(msg.dataUrl)) {
        this.ports.onSharedImage(msg.dataUrl)
        this.say('image received - see Shares')
      }
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
          this.say('not connected - transfer cancelled')
          this.queue.length = 0
          return
        }
        this.say(`sending ${blob.name}...`)
        try {
          await sendFile({
            ctrl,
            file,
            blob,
            onProgress: (p) =>
              this.say(`sending ${p.name} - ${Math.round((p.sent / p.total) * 100)}%`, true)
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
    if (result.saved) this.ports.onSharedFile(name, result.path)
    const ctrl = this.ports.channels().ctrl
    if (ctrl?.readyState === 'open') {
      ctrl.send(JSON.stringify({ t: 'file-ack', id: name, ok: result.saved }))
    }
  }

  /** replace=true overwrites the last line, so progress does not spam the log. */
  say(text: string, replace = false): void {
    if (replace && this.log.firstElementChild) {
      this.log.firstElementChild.textContent = text
      return
    }
    const li = document.createElement('li')
    li.textContent = text
    this.log.prepend(li)
    while (this.log.childElementCount > MAX_LOG_LINES) this.log.lastElementChild?.remove()
  }
}
