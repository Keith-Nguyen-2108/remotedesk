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
