import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { PROTOCOL_VERSION, RelayServer } from '../../server/src/relay-server'

let server: RelayServer | null = null

afterEach(async () => {
  await server?.stop()
  server = null
})

async function startServer(): Promise<number> {
  const s = new RelayServer()
  const port = await s.start(0)
  server = s
  return port
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), 3000)
    ws.once('message', (data) => {
      clearTimeout(timer)
      resolve(JSON.parse(data.toString()) as Record<string, unknown>)
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

function open(port: number): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}`)
}

describe('RelayServer', () => {
  it('pairs a connect-request with a matching registration', async () => {
    const port = await startServer()
    const listener = open(port)
    listener.on('open', () =>
      listener.send(JSON.stringify({ t: 'register', keyHash: 'abc', version: PROTOCOL_VERSION }))
    )
    await new Promise((r) => setTimeout(r, 100))
    expect(server?.waitingCount()).toBe(1)

    const requester = open(port)
    requester.on('open', () =>
      requester.send(
        JSON.stringify({ t: 'connect-request', keyHash: 'abc', version: PROTOCOL_VERSION })
      )
    )

    const [reqMsg, listMsg] = await Promise.all([nextMessage(requester), nextMessage(listener)])
    expect(reqMsg).toEqual({ t: 'paired' })
    expect(listMsg).toEqual({ t: 'paired' })
    expect(server?.waitingCount()).toBe(0)

    requester.close()
    listener.close()
  })

  it('forwards opaque frames bidirectionally once paired', async () => {
    const port = await startServer()
    const listener = open(port)
    listener.on('open', () =>
      listener.send(JSON.stringify({ t: 'register', keyHash: 'xyz', version: PROTOCOL_VERSION }))
    )
    await new Promise((r) => setTimeout(r, 100))

    const requester = open(port)
    requester.on('open', () =>
      requester.send(
        JSON.stringify({ t: 'connect-request', keyHash: 'xyz', version: PROTOCOL_VERSION })
      )
    )
    await Promise.all([nextMessage(requester), nextMessage(listener)])

    requester.send(JSON.stringify({ t: 'offer', sdp: 'v=0 offer' }))
    expect(await nextMessage(listener)).toEqual({ t: 'offer', sdp: 'v=0 offer' })

    listener.send(JSON.stringify({ t: 'answer', sdp: 'v=0 answer' }))
    expect(await nextMessage(requester)).toEqual({ t: 'answer', sdp: 'v=0 answer' })

    requester.close()
    listener.close()
  })

  it('tells a connect-request nobody is registered under that key', async () => {
    const port = await startServer()
    const requester = open(port)
    requester.on('open', () =>
      requester.send(
        JSON.stringify({ t: 'connect-request', keyHash: 'nobody-home', version: PROTOCOL_VERSION })
      )
    )
    expect(await nextMessage(requester)).toEqual({ t: 'peer-offline' })
    await nextClose(requester)
  })

  it('closes the other side when one side of a pairing disconnects', async () => {
    const port = await startServer()
    const listener = open(port)
    listener.on('open', () =>
      listener.send(JSON.stringify({ t: 'register', keyHash: 'gone', version: PROTOCOL_VERSION }))
    )
    await new Promise((r) => setTimeout(r, 100))

    const requester = open(port)
    requester.on('open', () =>
      requester.send(
        JSON.stringify({ t: 'connect-request', keyHash: 'gone', version: PROTOCOL_VERSION })
      )
    )
    await Promise.all([nextMessage(requester), nextMessage(listener)])

    requester.close()
    await nextClose(listener)
  })

  it('a fresh registration under the same key replaces the stale one', async () => {
    const port = await startServer()
    const first = open(port)
    first.on('open', () =>
      first.send(JSON.stringify({ t: 'register', keyHash: 'dup', version: PROTOCOL_VERSION }))
    )
    await new Promise((r) => setTimeout(r, 100))

    const second = open(port)
    second.on('open', () =>
      second.send(JSON.stringify({ t: 'register', keyHash: 'dup', version: PROTOCOL_VERSION }))
    )
    await nextClose(first)
    expect(server?.waitingCount()).toBe(1)

    const requester = open(port)
    requester.on('open', () =>
      requester.send(
        JSON.stringify({ t: 'connect-request', keyHash: 'dup', version: PROTOCOL_VERSION })
      )
    )
    // The NEW registration is the one that gets paired, not the superseded one.
    await Promise.all([nextMessage(requester), nextMessage(second)])
    requester.close()
    second.close()
  })

  it('rejects a version mismatch', async () => {
    const port = await startServer()
    const ws = open(port)
    ws.on('open', () => ws.send(JSON.stringify({ t: 'register', keyHash: 'v', version: 99 })))
    expect(await nextMessage(ws)).toEqual({ t: 'bad-version' })
    await nextClose(ws)
  })

  it('drops a connection that never registers or requests', async () => {
    const port = await startServer()
    const ws = open(port)
    ws.on('open', () => ws.send(JSON.stringify({ t: 'launch-missiles' })))
    await nextClose(ws)
  })

  it('rejects a message with no keyHash', async () => {
    const port = await startServer()
    const ws = open(port)
    ws.on('open', () => ws.send(JSON.stringify({ t: 'register', version: PROTOCOL_VERSION })))
    await nextClose(ws)
  })

  it('never learns the raw token, only whatever hash the client sends', async () => {
    // The relay has no notion of a "token" at all - it only ever handles
    // whatever opaque keyHash string a client sends it. This test documents
    // that contract: two different-looking hashes never collide by accident.
    const port = await startServer()
    const a = open(port)
    a.on('open', () =>
      a.send(JSON.stringify({ t: 'register', keyHash: 'hash-a', version: PROTOCOL_VERSION }))
    )
    const b = open(port)
    b.on('open', () =>
      b.send(JSON.stringify({ t: 'register', keyHash: 'hash-b', version: PROTOCOL_VERSION }))
    )
    await new Promise((r) => setTimeout(r, 100))
    expect(server?.waitingCount()).toBe(2)
    a.close()
    b.close()
  })
})
