import { FILE_CHUNK_SIZE } from './protocol'

/**
 * These bytes never cross into a worker, so the backing store is always a plain
 * ArrayBuffer. Stating that (rather than the default ArrayBufferLike, which
 * includes SharedArrayBuffer) is what lets RTCDataChannel.send take a chunk
 * directly and crypto.subtle.digest take one without a cast.
 */
export type Bytes = Uint8Array<ArrayBuffer>

export interface FileMeta {
  id: string
  name: string
  size: number
  mime: string
}

export function chunkBuffer(
  data: Bytes,
  chunkSize: number = FILE_CHUNK_SIZE
): Bytes[] {
  const chunks: Bytes[] = []
  for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
    chunks.push(data.subarray(offset, Math.min(offset + chunkSize, data.byteLength)))
  }
  return chunks
}

/** WebCrypto is available both in the renderer and in Node 20+, so this module stays portable. */
export async function sha256Hex(data: Bytes): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export class FileReassembler {
  private readonly parts: Bytes[] = []
  private received = 0

  constructor(readonly meta: FileMeta) {}

  push(chunk: Bytes): void {
    if (this.received + chunk.byteLength > this.meta.size) {
      throw new Error(
        `chunk exceeds declared size for ${this.meta.name}: ${this.received + chunk.byteLength} > ${this.meta.size}`
      )
    }
    this.parts.push(chunk)
    this.received += chunk.byteLength
  }

  receivedBytes(): number {
    return this.received
  }

  progress(): number {
    return this.meta.size === 0 ? 1 : this.received / this.meta.size
  }

  isComplete(): boolean {
    return this.received === this.meta.size
  }

  async finish(expectedSha256: string): Promise<Bytes> {
    if (!this.isComplete()) {
      throw new Error(`transfer incomplete: ${this.received}/${this.meta.size} bytes`)
    }
    const out = new Uint8Array(this.meta.size)
    let offset = 0
    for (const part of this.parts) {
      out.set(part, offset)
      offset += part.byteLength
    }
    const actual = await sha256Hex(out)
    if (actual !== expectedSha256) {
      throw new Error(`checksum mismatch for ${this.meta.name}`)
    }
    return out
  }
}
