import { clipboard as electronClipboard, nativeImage } from 'electron'
import { ClipboardSync, type ClipSnapshot } from '../shared/clipboard-sync'

/** Derived from a real value, so it cannot drift from the installed Electron. */
type NativeImg = ReturnType<typeof nativeImage.createFromDataURL>

/**
 * electron.d.ts types the exported `clipboard` as a bare `Clipboard`, but its
 * CrossProcessExports namespace never aliases that name. With `lib: ["DOM"]`
 * enabled (the renderer needs it) the name binds to the DOM's async
 * navigator.clipboard instead, which has no readImage/writeImage and an async
 * readText. Pin the shape of the main-process API we actually call.
 */
interface MainClipboard {
  readText(): string
  writeText(text: string): void
  readImage(): NativeImg
  writeImage(image: NativeImg): void
}

const clipboard = electronClipboard as unknown as MainClipboard

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
