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
