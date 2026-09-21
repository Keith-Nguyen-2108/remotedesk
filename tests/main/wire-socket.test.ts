import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import { wrapWebSocket } from '../../src/main/wire-socket'

let wss: WebSocketServer | null = null

afterEach(async () => {
  const server = wss
  wss = null
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
})

/**
 * A server that holds its socket so the test can push frames at an exact
 * moment. Frames are never sent before the client is wrapped, which mirrors
 * production: the socket always carries a control listener from creation, so
 * nothing is dropped by `ws` itself - the gap being tested is purely between
 * wrapping and the consumer registering onMessage.
 */
async function startServer(): Promise<{ port: number; send: (frame: string) => void; closeWith: (code: number, reason: string) => void }> {
  const server = new WebSocketServer({ port: 0 })
  let peer: WebSocket | null = null
  server.on('connection', (ws) => {
    peer = ws
  })
  wss = server
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  return {
    port: (server.address() as AddressInfo).port,
    send: (frame) => peer?.send(frame),
    closeWith: (code, reason) => peer?.close(code, reason)
  }
}

async function connectAndWrap(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise<void>((resolve) => ws.once('open', () => resolve()))
  // Mirrors the relay path, where a control listener already exists before
  // the connection is handed upwards.
  ws.on('message', () => undefined)
  return { ws, conn: wrapWebSocket(ws) }
}

const settle = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('wrapWebSocket', () => {
  it('delivers frames that arrived before a listener was attached', async () => {
    // The relay race: the peer starts talking the moment it is paired, while
    // this side is still threading the connection through async IPC.
    const server = await startServer()
    const { ws, conn } = await connectAndWrap(server.port)

    server.send('first')
    server.send('second')
    await settle()

    const received: string[] = []
    conn.onMessage((data) => received.push(data))
    await settle(20)

    expect(received).toEqual(['first', 'second'])
    ws.close()
  })

  it('still delivers frames that arrive after the listener is attached', async () => {
    const server = await startServer()
    const { ws, conn } = await connectAndWrap(server.port)

    const received: string[] = []
    conn.onMessage((data) => received.push(data))

    server.send('later')
    await settle()

    expect(received).toEqual(['later'])
    ws.close()
  })

  it('preserves ordering across the buffered/live boundary', async () => {
    const server = await startServer()
    const { ws, conn } = await connectAndWrap(server.port)

    server.send('buffered-1')
    server.send('buffered-2')
    await settle()

    const received: string[] = []
    conn.onMessage((data) => received.push(data))

    server.send('live-3')
    await settle()

    expect(received).toEqual(['buffered-1', 'buffered-2', 'live-3'])
    ws.close()
  })

  it('reports a close that happened before onClose was attached', async () => {
    const server = await startServer()
    const { conn } = await connectAndWrap(server.port)

    server.closeWith(4009, 'gone already')
    await settle(120)

    const closes: Array<[number, string]> = []
    conn.onClose((code, reason) => closes.push([code, reason]))
    await settle(20)

    expect(closes).toEqual([[4009, 'gone already']])
  })

  it('reports isOpen accurately', async () => {
    const server = await startServer()
    const { ws, conn } = await connectAndWrap(server.port)
    expect(conn.isOpen).toBe(true)
    ws.close()
    await settle(120)
    expect(conn.isOpen).toBe(false)
  })
})
