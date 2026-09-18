import { FILE_CHUNK_SIZE } from './protocol'

export interface FileMeta {
  id: string
  name: string
  size: number
  mime: string
}

export function chunkBuffer(data: Uint8Array, chunkSize: number = FILE_CHUNK_SIZE): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
    chunks.push(data.subarray(offset, Math.min(offset + chunkSize, data.byteLength)))
  }
  return chunks
}

/** WebCrypto is available both in the renderer and in Node 20+, so this module stays portable. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export class FileReassembler {
  private readonly parts: Uint8Array[] = []
  private received = 0

  constructor(readonly meta: FileMeta) {}

  push(chunk: Uint8Array): void {
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

  async finish(expectedSha256: string): Promise<Uint8Array> {
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
