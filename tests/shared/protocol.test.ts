import { describe, expect, it } from 'vitest'
import {
  DISCOVERY_MAGIC,
  FILE_CHUNK_SIZE,
  PROTOCOL_VERSION,
  parseCtrlMessage,
  parseInputMessage,
  parseJson,
  parseSignalMessage
} from '../../src/shared/protocol'

describe('constants', () => {
  it('pins the wire version and chunk size', () => {
    expect(PROTOCOL_VERSION).toBe(1)
    expect(FILE_CHUNK_SIZE).toBe(16 * 1024)
    expect(DISCOVERY_MAGIC).toBe('remotedesk-discover-v1')
  })
})

describe('parseJson', () => {
  it('returns null for malformed JSON instead of throwing', () => {
    expect(parseJson('{nope')).toBeNull()
  })

  it('parses valid JSON', () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 })
  })
})

describe('parseInputMessage', () => {
  it('accepts a normalized mouse move', () => {
    expect(parseInputMessage({ t: 'move', x: 0.5, y: 0.25 })).toEqual({
      t: 'move',
      x: 0.5,
      y: 0.25
    })
  })

  it('rejects coordinates outside 0..1', () => {
    expect(parseInputMessage({ t: 'move', x: 1.5, y: 0 })).toBeNull()
    expect(parseInputMessage({ t: 'move', x: -0.1, y: 0 })).toBeNull()
  })

  it('rejects non-finite coordinates', () => {
    expect(parseInputMessage({ t: 'move', x: Number.NaN, y: 0 })).toBeNull()
  })

  it('accepts mouse down/up with a known button', () => {
    expect(parseInputMessage({ t: 'down', b: 'left', x: 0, y: 0 })).toEqual({
      t: 'down',
      b: 'left',
      x: 0,
      y: 0
    })
    expect(parseInputMessage({ t: 'up', b: 'middle', x: 1, y: 1 })?.t).toBe('up')
  })

  it('rejects an unknown mouse button', () => {
    expect(parseInputMessage({ t: 'down', b: 'fourth', x: 0, y: 0 })).toBeNull()
  })

  it('accepts a wheel event', () => {
    expect(parseInputMessage({ t: 'wheel', dx: 0, dy: -120 })?.t).toBe('wheel')
  })

  it('accepts key events and rejects absurd key codes', () => {
    expect(parseInputMessage({ t: 'keydown', code: 'KeyA' })).toEqual({
      t: 'keydown',
      code: 'KeyA'
    })
    expect(parseInputMessage({ t: 'keyup', code: 'ShiftLeft' })?.t).toBe('keyup')
    expect(parseInputMessage({ t: 'keydown', code: 'x'.repeat(64) })).toBeNull()
    expect(parseInputMessage({ t: 'keydown', code: '' })).toBeNull()
  })

  it('rejects unknown message types and non-objects', () => {
    expect(parseInputMessage({ t: 'shutdown' })).toBeNull()
    expect(parseInputMessage('move')).toBeNull()
    expect(parseInputMessage(null)).toBeNull()
    expect(parseInputMessage([{ t: 'move', x: 0, y: 0 }])).toBeNull()
  })
})

describe('parseCtrlMessage', () => {
  it('accepts a link message', () => {
    expect(parseCtrlMessage({ t: 'link', url: 'https://example.com' })).toEqual({
      t: 'link',
      url: 'https://example.com'
    })
  })

  it('accepts clipboard text and image', () => {
    expect(parseCtrlMessage({ t: 'clip-text', text: 'hello' })?.t).toBe('clip-text')
    expect(parseCtrlMessage({ t: 'clip-image', dataUrl: 'data:image/png;base64,AA' })?.t).toBe(
      'clip-image'
    )
  })

  it('accepts file-begin and file-end', () => {
    expect(
      parseCtrlMessage({ t: 'file-begin', id: 'f1', name: 'a.png', size: 10, mime: 'image/png' })
    ).toEqual({ t: 'file-begin', id: 'f1', name: 'a.png', size: 10, mime: 'image/png' })
    expect(parseCtrlMessage({ t: 'file-end', id: 'f1', sha256: 'ab12' })?.t).toBe('file-end')
  })

  it('rejects a negative or oversized file size', () => {
    expect(
      parseCtrlMessage({ t: 'file-begin', id: 'f1', name: 'a', size: -1, mime: '' })
    ).toBeNull()
    expect(
      parseCtrlMessage({ t: 'file-begin', id: 'f1', name: 'a', size: 5e10, mime: '' })
    ).toBeNull()
  })

  it('accepts screen-info', () => {
    expect(parseCtrlMessage({ t: 'screen-info', width: 1920, height: 1080 })?.t).toBe('screen-info')
  })
})

describe('parseSignalMessage', () => {
  it('accepts the handshake messages', () => {
    expect(
      parseSignalMessage({ t: 'challenge', challenge: 'ab', hostName: 'Mac', version: 1 })?.t
    ).toBe('challenge')
    expect(parseSignalMessage({ t: 'auth', proof: 'cd', clientName: 'PC', version: 1 })?.t).toBe(
      'auth'
    )
    expect(parseSignalMessage({ t: 'auth-ok' })).toEqual({ t: 'auth-ok' })
  })

  it('accepts sdp and ice payloads', () => {
    expect(parseSignalMessage({ t: 'offer', sdp: 'v=0' })?.t).toBe('offer')
    expect(parseSignalMessage({ t: 'answer', sdp: 'v=0' })?.t).toBe('answer')
    const ice = parseSignalMessage({
      t: 'ice',
      candidate: { candidate: 'candidate:1 1 udp', sdpMid: '0', sdpMLineIndex: 0 }
    })
    expect(ice?.t).toBe('ice')
  })

  it('rejects an ice payload with a non-string candidate', () => {
    expect(parseSignalMessage({ t: 'ice', candidate: { candidate: 5 } })).toBeNull()
  })
})
