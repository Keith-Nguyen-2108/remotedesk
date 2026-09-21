import { afterEach, describe, expect, it } from 'vitest'
import { RelayServer } from '../../server/src/relay-server'
import { connectViaRelay, RelayListener } from '../../src/main/relay-transport'
import { SignalingClient } from '../../src/main/signaling-client'
import { SignalingServer } from '../../src/main/signaling-server'
import type { SignalMessage } from '../../src/shared/protocol'

/**
 * The whole "two machines on different networks" path, with a real relay
 * server standing in for a public VPS: no LAN discovery involved at all -
 * this is exactly what a Vietnam <-> US connection goes through.
 */

let relay: RelayServer | null = null
let listener: RelayListener | null = null
let server: SignalingServer | null = null
let client: SignalingClient | null = null

afterEach(async () => {
  await client?.close()
  listener?.stop()
  await server?.stop()
  await relay?.stop()
  client = null
  listener = null
  server = null
  relay = null
})

interface Reachable {
  received: SignalMessage[]
  joined: string[]
}

async function makeReachable(relayUrl: string, token: string): Promise<Reachable> {
  const state: Reachable = { received: [], joined: [] }

  const s = new SignalingServer({
    port: 0,
    secret: () => token,
    hostName: 'USBox',
    onClientAuthenticated: (name) => state.joined.push(name),
    onMessage: (msg) => state.received.push(msg),
    onClientGone: () => state.joined.push('<gone>')
  })
  await s.start()
  server = s

  const l = new RelayListener({
    url: relayUrl,
    token: () => token,
    onInbound: (conn) => s.handleExternalConnection(conn),
    onStatus: () => undefined
  })
  l.start()
  listener = l

  // Give the registration a moment to land before anyone tries to reach it.
  await new Promise((r) => setTimeout(r, 150))
  return state
}

describe('connect over the internet relay', () => {
  it('pairs and authenticates two machines that share no network', async () => {
    const r = new RelayServer()
    const port = await r.start(0)
    relay = r
    const relayUrl = `ws://127.0.0.1:${port}`

    const remote = await makeReachable(relayUrl, '444455556666')

    const events: string[] = []
    const c = new SignalingClient({
      secret: '444455556666',
      clientName: 'VietnamLaptop',
      onConnected: (hostName) => events.push(`connected:${hostName}`),
      onMessage: (msg) => events.push(`msg:${msg.t}`),
      onClosed: () => undefined
    })

    const conn = await connectViaRelay(relayUrl, '444455556666')
    await c.attach(conn)
    client = c

    expect(events).toEqual(['connected:USBox'])
    expect(remote.joined).toContain('VietnamLaptop')

    c.send({ t: 'offer', sdp: 'v=0 from vietnam' })
    await new Promise((r2) => setTimeout(r2, 100))
    expect(remote.received).toEqual([{ t: 'offer', sdp: 'v=0 from vietnam' }])
  })

  it('rejects when the ID is wrong, even though the relay found a match', async () => {
    const r = new RelayServer()
    const port = await r.start(0)
    relay = r
    const relayUrl = `ws://127.0.0.1:${port}`

    await makeReachable(relayUrl, '444455556666')

    const c = new SignalingClient({
      secret: '000000000000',
      clientName: 'Attacker',
      onConnected: () => undefined,
      onMessage: () => undefined,
      onClosed: () => undefined
    })

    const conn = await connectViaRelay(relayUrl, '444455556666')
    await expect(c.attach(conn)).rejects.toThrow(/id|auth|reject/i)
  })

  it('reports that nobody is reachable under an ID the relay has never seen', async () => {
    const r = new RelayServer()
    const port = await r.start(0)
    relay = r

    await expect(connectViaRelay(`ws://127.0.0.1:${port}`, '999999999999')).rejects.toThrow(
      /not reachable/i
    )
  })

  it('re-registers after a session ends, so a second connection can still find it', async () => {
    const r = new RelayServer()
    const port = await r.start(0)
    relay = r
    const relayUrl = `ws://127.0.0.1:${port}`

    await makeReachable(relayUrl, '111122223333')

    const first = new SignalingClient({
      secret: '111122223333',
      clientName: 'First',
      onConnected: () => undefined,
      onMessage: () => undefined,
      onClosed: () => undefined
    })
    const firstConn = await connectViaRelay(relayUrl, '111122223333')
    await first.attach(firstConn)
    await first.close()

    // Give the listener a moment to notice the pairing ended and re-register.
    await new Promise((r2) => setTimeout(r2, 500))

    const second = new SignalingClient({
      secret: '111122223333',
      clientName: 'Second',
      onConnected: () => undefined,
      onMessage: () => undefined,
      onClosed: () => undefined
    })
    const secondConn = await connectViaRelay(relayUrl, '111122223333')
    await second.attach(secondConn)
    client = second
  })
})
