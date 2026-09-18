import { FileReassembler, chunkBuffer, sha256Hex, type FileMeta } from '../../shared/filechunk'
import { DATA_CHANNEL_HIGH_WATER, type CtrlMessage } from '../../shared/protocol'

export interface SendProgress {
  name: string
  sent: number
  total: number
}

function waitForDrain(channel: RTCDataChannel): Promise<void> {
  return new Promise((resolve) => {
    channel.bufferedAmountLowThreshold = Math.floor(DATA_CHANNEL_HIGH_WATER / 2)
    const handler = (): void => {
      channel.removeEventListener('bufferedamountlow', handler)
      resolve()
    }
    channel.addEventListener('bufferedamountlow', handler)
  })
}

/** Sends one file: metadata on ctrl, bytes on file, checksum on ctrl. */
export async function sendFile(args: {
  ctrl: RTCDataChannel
  file: RTCDataChannel
  blob: File
  onProgress: (p: SendProgress) => void
}): Promise<void> {
  const { ctrl, file, blob, onProgress } = args
  if (ctrl.readyState !== 'open' || file.readyState !== 'open') {
    throw new Error('not connected')
  }

  const bytes = new Uint8Array(await blob.arrayBuffer())
  const id = globalThis.crypto.randomUUID()
  const begin: CtrlMessage = {
    t: 'file-begin',
    id,
    name: blob.name,
    size: bytes.byteLength,
    mime: blob.type
  }
  ctrl.send(JSON.stringify(begin))

  let sent = 0
  for (const chunk of chunkBuffer(bytes)) {
    // Without backpressure a big file buries the input channel behind its queue.
    if (file.bufferedAmount > DATA_CHANNEL_HIGH_WATER) await waitForDrain(file)
    file.send(chunk)
    sent += chunk.byteLength
    onProgress({ name: blob.name, sent, total: bytes.byteLength })
  }

  const end: CtrlMessage = { t: 'file-end', id, sha256: await sha256Hex(bytes) }
  ctrl.send(JSON.stringify(end))
}

/**
 * Receiving side. Only one transfer is in flight at a time (the sender queues),
 * so a single active reassembler is enough.
 */
export class FileReceiver {
  private active: FileReassembler | null = null

  constructor(
    private readonly cb: {
      onProgress: (name: string, progress: number) => void
      onDone: (name: string, mime: string, bytes: Uint8Array) => void
      onError: (message: string) => void
    }
  ) {}

  begin(meta: FileMeta): void {
    this.active = new FileReassembler(meta)
    this.cb.onProgress(meta.name, 0)
  }

  chunk(data: ArrayBuffer): void {
    if (!this.active) return
    try {
      this.active.push(new Uint8Array(data))
      this.cb.onProgress(this.active.meta.name, this.active.progress())
    } catch (err) {
      this.cb.onError((err as Error).message)
      this.active = null
    }
  }

  async end(sha256: string): Promise<void> {
    const active = this.active
    this.active = null
    if (!active) return
    try {
      const bytes = await active.finish(sha256)
      this.cb.onDone(active.meta.name, active.meta.mime, bytes)
    } catch (err) {
      this.cb.onError((err as Error).message)
    }
  }

  reset(): void {
    this.active = null
  }
}
