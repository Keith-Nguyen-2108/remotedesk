import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { computeProof } from '../../src/shared/auth'
import { PROTOCOL_VERSION, parseJson, parseSignalMessage } from '../../src/shared/protocol'
import type { SignalMessage } from '../../src/shared/protocol'
import {
  CLOSE_AUTH_FAILED,
  CLOSE_BAD_VERSION,
  CLOSE_BUSY,
  SignalingServer
} from '../../src/main/signaling-server'

let server: SignalingServer | null = null

afterEach(async () => {
  await server?.stop()
  server = null
})

/** Resolve with the next parsed signal message, or reject on timeout. */
function nextMessage(ws: WebSocket): Promise<SignalMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), 3000)
    ws.once('message', (data) => {
      clearTimeout(timer)
      const msg = parseSignalMessage(parseJson(data.toString()))
      if (!msg) reject(new Error(`unparseable: ${data.toString()}`))
      else resolve(msg)
    })
  })
}

function nextClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for close')), 3000)
    ws.once('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

async function startServer(overrides: Partial<{ secret: string }> = {}) {
  const received: SignalMessage[] = []
  const authed: string[] = []
  const s = new SignalingServer({
    port: 0,
    secret: () => overrides.secret ?? '123456789012',
    hostName: 'TestHost',
    onClientAuthenticated: (name) => authed.push(name),
    onMessage: (msg) => received.push(msg),
    onClientGone: () => authed.push('<gone>')
  })
  const port = await s.start()
  server = s
  return { s, port, received, authed }
}

async function authenticate(port: number, secret: string, clientName = 'Laptop'): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const challenge = await nextMessage(ws)
  if (challenge.t !== 'challenge') throw new Error('expected challenge')
  ws.send(
    JSON.stringify({
      t: 'auth',
      proof: computeProof(secret, challenge.challenge),
      clientName,
      version: PROTOCOL_VERSION
    })
  )
  await nextMessage(ws)
  return ws
}

describe('SignalingServer', () => {
  it('greets a new connection with a challenge', async () => {
    const { port } = await startServer()
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const msg = await nextMessage(ws)
    expect(msg.t).toBe('challenge')
    if (msg.t === 'challenge') {
      expect(msg.hostName).toBe('TestHost')
      expect(msg.version).toBe(PROTOCOL_VERSION)
      expect(msg.challenge).toMatch(/^[0-9a-f]{64}$/)
    }
    ws.close()
  })

  it('accepts a client that proves the right ID', async () => {
    const { port, authed } = await startServer({ secret: '111222333444' })
    const ws = await authenticate(port, '111222333444')
    expect(authed).toContain('Laptop')
    ws.close()
  })

  it('closes with CLOSE_AUTH_FAILED on a wrong ID', async () => {
    const { port } = await startServer({ secret: '111222333444' })
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const challenge = await nextMessage(ws)
    if (challenge.t !== 'challenge') throw new Error('expected challenge')
    ws.send(
      JSON.stringify({
        t: 'auth',
        proof: computeProof('999999888877', challenge.challenge),
        clientName: 'Attacker',
        version: PROTOCOL_VERSION
      })
    )
    expect(await nextClose(ws)).toBe(CLOSE_AUTH_FAILED)
  })

  it('closes with CLOSE_BAD_VERSION on a protocol mismatch', async () => {
    const { port } = await startServer()
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const challenge = await nextMessage(ws)
    if (challenge.t !== 'challenge') throw new Error('expected challenge')
    ws.send(
      JSON.stringify({
        t: 'auth',
        proof: computeProof('123456789012', challenge.challenge),
        clientName: 'Old',
        version: 99
      })
    )
    expect(await nextClose(ws)).toBe(CLOSE_BAD_VERSION)
  })

  it('refuses signaling traffic before auth', async () => {
    const { port, received } = await startServer()
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    await nextMessage(ws)
    ws.send(JSON.stringify({ t: 'answer', sdp: 'v=0' }))
    expect(await nextClose(ws)).toBe(CLOSE_AUTH_FAILED)
    expect(received).toHaveLength(0)
  })

  it('rejects a second client while one is connected', async () => {
    const { port } = await startServer()
    const first = await authenticate(port, '123456789012', 'First')
    const second = new WebSocket(`ws://127.0.0.1:${port}`)
    expect(await nextClose(second)).toBe(CLOSE_BUSY)
    first.close()
  })

  it('relays client signaling messages to the app and back', async () => {
    const { s, port, received } = await startServer()
    const ws = await authenticate(port, '123456789012')

    ws.send(JSON.stringify({ t: 'answer', sdp: 'v=0 answer' }))
    await new Promise((r) => setTimeout(r, 100))
    expect(received).toEqual([{ t: 'answer', sdp: 'v=0 answer' }])

    s.send({ t: 'offer', sdp: 'v=0 offer' })
    const relayed = await nextMessage(ws)
    expect(relayed).toEqual({ t: 'offer', sdp: 'v=0 offer' })
    ws.close()
  })

  it('drops malformed frames without closing an authenticated session', async () => {
    const { port, received } = await startServer()
    const ws = await authenticate(port, '123456789012')

    ws.send('{not json')
    ws.send(JSON.stringify({ t: 'launch-missiles' }))
    ws.send(JSON.stringify({ t: 'answer', sdp: 'v=0 ok' }))
    await new Promise((r) => setTimeout(r, 100))
    expect(received).toEqual([{ t: 'answer', sdp: 'v=0 ok' }])
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })
})

import { SignalingClient } from '../../src/main/signaling-client'

describe('SignalingClient', () => {
  it('completes the handshake against the real server', async () => {
    const { port, received } = await startServer({ secret: '222333444555' })
    const events: string[] = []
    const client = new SignalingClient({
      secret: '222333444555',
      clientName: 'Laptop',
      onConnected: (hostName) => events.push(`connected:${hostName}`),
      onMessage: (msg) => events.push(`msg:${msg.t}`),
      onClosed: (code) => events.push(`closed:${code}`)
    })

    await client.connect('127.0.0.1', port)
    expect(events).toContain('connected:TestHost')

    client.send({ t: 'answer', sdp: 'v=0 from client' })
    await new Promise((r) => setTimeout(r, 100))
    expect(received).toEqual([{ t: 'answer', sdp: 'v=0 from client' }])

    await client.close()
  })

  it('rejects connect() when the ID is wrong', async () => {
    const { port } = await startServer({ secret: '222333444555' })
    const client = new SignalingClient({
      secret: '000000111122',
      clientName: 'Laptop',
      onConnected: () => undefined,
      onMessage: () => undefined,
      onClosed: () => undefined
    })

    await expect(client.connect('127.0.0.1', port)).rejects.toThrow(/id|auth|reject/i)
  })

  it('surfaces a readable reason when the host is busy', async () => {
    const { port } = await startServer({ secret: '222333444555' })
    const first = await authenticate(port, '222333444555', 'First')
    const client = new SignalingClient({
      secret: '222333444555',
      clientName: 'Second',
      onConnected: () => undefined,
      onMessage: () => undefined,
      onClosed: () => undefined
    })

    await expect(client.connect('127.0.0.1', port)).rejects.toThrow(/already has a client|client is connected/i)
    first.close()
  })
})
