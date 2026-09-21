import { afterEach, describe, expect, it } from 'vitest'
import { RelayServer } from '../../server/src/relay-server'
import { connectViaRelay, RelayListener } from '../../src/main/relay-transport'
import { SignalingClient } from '../../src/main/signaling-client'
import { SignalingServer } from '../../src/main/signaling-server'
import type { SignalMessage } from '../../src/shared/protocol'

/**
 * The whole signalling exchange a real session depends on, over a real relay:
 * approval, then the offer/answer/ICE traffic that WebRTC needs to actually
 * connect. If any of these frames go missing the two machines negotiate
 * "successfully" and still show a black screen forever, which is exactly the
 * failure this covers.
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
  client = listener = null
  server = null
  relay = null
})

const TOKEN = '246813579024'
const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Host {
  received: SignalMessage[]
  joined: string[]
  closedReasons: string[]
  send: (msg: SignalMessage) => void
  abort: (reason: string) => void
}

async function bootHost(relayUrl: string, approve = true): Promise<Host> {
  const state: Host = {
    received: [],
    joined: [],
    closedReasons: [],
    send: () => undefined,
    abort: () => undefined
  }

  const s = new SignalingServer({
    port: 0,
    secret: () => TOKEN,
    hostName: 'HostBox',
    approveClient: async () => approve,
    onClientAuthenticated: (name) => state.joined.push(name),
    onMessage: (msg) => state.received.push(msg),
    onClientGone: () => state.joined.push('<gone>')
  })
  await s.start()
  server = s
  state.send = (msg) => s.send(msg)
  state.abort = (reason) => s.disconnectClient(reason)

  const l = new RelayListener({
    url: relayUrl,
    token: () => TOKEN,
    onInbound: (conn) => s.handleExternalConnection(conn),
    onStatus: () => undefined
  })
  l.start()
  listener = l

  await settle()
  return state
}

async function startRelay(): Promise<string> {
  const r = new RelayServer()
  const port = await r.start(0)
  relay = r
  return `ws://127.0.0.1:${port}`
}

describe('session negotiation over the relay', () => {
  it('carries a full offer / answer / ICE exchange in both directions', async () => {
    const relayUrl = await startRelay()
    const host = await bootHost(relayUrl)

    const fromHost: SignalMessage[] = []
    const c = new SignalingClient({
      secret: TOKEN,
      clientName: 'ViewerBox',
      onConnected: () => undefined,
      onMessage: (msg) => fromHost.push(msg),
      onClosed: () => undefined
    })
    await c.attach(await connectViaRelay(relayUrl, TOKEN))
    client = c

    // Host offers, exactly as HostSession.start() does after capturing.
    host.send({ t: 'offer', sdp: 'v=0 host offer' })
    host.send({
      t: 'ice',
      candidate: { candidate: 'candidate:host-1 1 udp', sdpMid: '0', sdpMLineIndex: 0 }
    })
    await settle()

    expect(fromHost).toEqual([
      { t: 'offer', sdp: 'v=0 host offer' },
      {
        t: 'ice',
        candidate: {
          candidate: 'candidate:host-1 1 udp',
          sdpMid: '0',
          sdpMLineIndex: 0,
          usernameFragment: null
        }
      }
    ])

    // Client answers and trickles its own candidate back.
    c.send({ t: 'answer', sdp: 'v=0 viewer answer' })
    c.send({
      t: 'ice',
      candidate: { candidate: 'candidate:viewer-1 1 udp', sdpMid: '0', sdpMLineIndex: 0 }
    })
    await settle()

    expect(host.received).toEqual([
      { t: 'answer', sdp: 'v=0 viewer answer' },
      {
        t: 'ice',
        candidate: {
          candidate: 'candidate:viewer-1 1 udp',
          sdpMid: '0',
          sdpMLineIndex: 0,
          usernameFragment: null
        }
      }
    ])
  })

  it('tells the viewer why when the host cannot share its screen', async () => {
    // Previously the host just silently never sent an offer and the viewer sat
    // on "waiting for their screen" forever with nothing to go on.
    const relayUrl = await startRelay()
    const host = await bootHost(relayUrl)

    const closes: string[] = []
    const c = new SignalingClient({
      secret: TOKEN,
      clientName: 'ViewerBox',
      onConnected: () => undefined,
      onMessage: () => undefined,
      onClosed: (_code, reason) => closes.push(reason)
    })
    await c.attach(await connectViaRelay(relayUrl, TOKEN))
    client = c

    host.abort('the other machine has not granted Screen Recording')
    await settle(250)

    expect(closes).toEqual(['the other machine has not granted Screen Recording'])
  })

  it('surfaces a refusal rather than hanging when the host denies', async () => {
    const relayUrl = await startRelay()
    await bootHost(relayUrl, false)

    const c = new SignalingClient({
      secret: TOKEN,
      clientName: 'ViewerBox',
      onConnected: () => undefined,
      onMessage: () => undefined,
      onClosed: () => undefined
    })

    await expect(c.attach(await connectViaRelay(relayUrl, TOKEN))).rejects.toThrow(/reject/i)
  })
})
