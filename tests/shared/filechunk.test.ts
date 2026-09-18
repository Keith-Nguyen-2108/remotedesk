import { describe, expect, it } from 'vitest'
import { FILE_CHUNK_SIZE } from '../../src/shared/protocol'
import { FileReassembler, chunkBuffer, sha256Hex } from '../../src/shared/filechunk'

function makeBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = i % 256
  return out
}

describe('chunkBuffer', () => {
  it('splits into full chunks plus a remainder', () => {
    const chunks = chunkBuffer(makeBytes(40_000))
    expect(chunks.map((c) => c.byteLength)).toEqual([FILE_CHUNK_SIZE, FILE_CHUNK_SIZE, 7232])
  })

  it('returns a single chunk for a small payload', () => {
    expect(chunkBuffer(makeBytes(10)).map((c) => c.byteLength)).toEqual([10])
  })

  it('returns no chunks for an empty payload', () => {
    expect(chunkBuffer(makeBytes(0))).toEqual([])
  })

  it('honours a custom chunk size', () => {
    expect(chunkBuffer(makeBytes(10), 4).map((c) => c.byteLength)).toEqual([4, 4, 2])
  })
})

describe('sha256Hex', () => {
  it('hashes the well-known empty input', async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
  })

  it('is stable for the same bytes', async () => {
    expect(await sha256Hex(makeBytes(1000))).toBe(await sha256Hex(makeBytes(1000)))
  })
})

describe('FileReassembler', () => {
  it('round-trips a payload through chunks', async () => {
    const original = makeBytes(40_000)
    const hash = await sha256Hex(original)
    const r = new FileReassembler({ id: 'f1', name: 'a.bin', size: original.byteLength, mime: '' })

    for (const chunk of chunkBuffer(original)) r.push(chunk)

    expect(r.isComplete()).toBe(true)
    const result = await r.finish(hash)
    expect(result.byteLength).toBe(original.byteLength)
    expect(Array.from(result.slice(0, 5))).toEqual([0, 1, 2, 3, 4])
  })

  it('reports progress as it goes', () => {
    const r = new FileReassembler({ id: 'f1', name: 'a.bin', size: 100, mime: '' })
    expect(r.progress()).toBe(0)
    r.push(makeBytes(50))
    expect(r.progress()).toBe(0.5)
    expect(r.isComplete()).toBe(false)
  })

  it('rejects more bytes than the declared size', () => {
    const r = new FileReassembler({ id: 'f1', name: 'a.bin', size: 10, mime: '' })
    expect(() => r.push(makeBytes(11))).toThrow(/exceeds/i)
  })

  it('refuses to finish before every byte arrived', async () => {
    const r = new FileReassembler({ id: 'f1', name: 'a.bin', size: 100, mime: '' })
    r.push(makeBytes(50))
    await expect(r.finish('whatever')).rejects.toThrow(/incomplete/i)
  })

  it('refuses to finish when the hash does not match', async () => {
    const r = new FileReassembler({ id: 'f1', name: 'a.bin', size: 10, mime: '' })
    r.push(makeBytes(10))
    await expect(r.finish('0'.repeat(64))).rejects.toThrow(/checksum/i)
  })
})
