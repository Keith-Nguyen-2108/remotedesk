import { clipboard as electronClipboard, ClipboardItem } from 'electron'
import { ClipboardSync, type ClipSnapshot } from '../shared/clipboard-sync'

/**
 * electron.d.ts types the exported `clipboard` as a bare `Clipboard`, but its
 * CrossProcessExports namespace never aliases that name. With `lib: ["DOM"]`
 * enabled (the renderer needs it) the name binds to the DOM's own
 * navigator.clipboard instead. Pin the shape of the main-process API we
 * actually call - which, as of this Electron version, is itself modeled on
 * the W3C async Clipboard API: readText/writeText/read/write/has all return
 * Promises, and images travel as ClipboardItem entries keyed by MIME type
 * rather than through dedicated readImage/writeImage methods.
 */
interface MainClipboard {
  readText(): Promise<string>
  writeText(text: string): Promise<void>
  read(): Promise<Array<{ types: string[]; getType(type: string): Promise<Blob> }>>
  write(items: ClipboardItem[]): Promise<void>
}

/**
 * Not hoisted into a module-level const, purely so every access goes through
 * one typed accessor rather than the mistyped `import { clipboard }` binding
 * directly. (An earlier version of this file assumed the pre-async
 * readImage/writeImage API and crashed here with "readImage is not a
 * function" - confirmed by testing that neither exists on this Electron's
 * clipboard object at all, at any point after startup. The real fix was
 * switching to the read/write/ClipboardItem shape below, not timing.)
 */
function mainClipboard(): MainClipboard {
  return electronClipboard as unknown as MainClipboard
}

const POLL_INTERVAL_MS = 800

const DATA_URL = /^data:([^;]+);base64,(.+)$/

async function readClipboard(): Promise<ClipSnapshot | null> {
  const clipboard = mainClipboard()

  const items = await clipboard.read()
  for (const item of items) {
    const imageType = item.types.find((t) => t.startsWith('image/'))
    if (imageType) {
      const blob = await item.getType(imageType)
      const buffer = Buffer.from(await blob.arrayBuffer())
      return { kind: 'image', dataUrl: `data:${imageType};base64,${buffer.toString('base64')}` }
    }
  }

  const text = await clipboard.readText()
  return text ? { kind: 'text', text } : null
}

async function writeClipboard(snapshot: ClipSnapshot): Promise<void> {
  const clipboard = mainClipboard()

  if (snapshot.kind === 'text') {
    await clipboard.writeText(snapshot.text)
    return
  }

  const match = DATA_URL.exec(snapshot.dataUrl)
  if (!match) return
  const [, mime, base64] = match
  const blob = new Blob([Buffer.from(base64!, 'base64')], { type: mime })
  await clipboard.write([new ClipboardItem({ [mime!]: blob })])
}

export class ClipboardWatcher {
  private sync = new ClipboardSync({ read: readClipboard, write: writeClipboard })
  private timer: NodeJS.Timeout | null = null
  private polling = false

  constructor(private readonly onLocalChange: (snapshot: ClipSnapshot) => void) {}

  start(): void {
    if (this.timer) return
    // Fresh state per session, so the baseline is taken when sharing starts.
    this.sync = new ClipboardSync({ read: readClipboard, write: writeClipboard })
    this.timer = setInterval(() => {
      // A slow OS clipboard read could still be in flight when the next tick
      // fires; skip that tick rather than letting polls pile up.
      if (this.polling) return
      this.polling = true
      void this.sync
        .poll()
        .then((snapshot) => {
          if (snapshot) this.onLocalChange(snapshot)
        })
        .finally(() => {
          this.polling = false
        })
    }, POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async applyRemote(snapshot: ClipSnapshot): Promise<void> {
    await this.sync.applyRemote(snapshot)
  }
}
