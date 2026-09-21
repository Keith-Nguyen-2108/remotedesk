import { afterEach, describe, expect, it } from 'vitest'
import { DiscoveryResponder, findHostByToken } from '../../src/main/discovery'
import { SignalingClient } from '../../src/main/signaling-client'
import { SignalingServer } from '../../src/main/signaling-server'
import type { SignalMessage } from '../../src/shared/protocol'

/**
 * The whole "paste an ID and press Connect" path, end to end, with real UDP and
 * real WebSockets: resolve the ID to an address, then authenticate with it.
 */

const DISCOVERY_PORT = 45880
const LOOPBACK = '127.0.0.1'

let responder: DiscoveryResponder | null = null
let server: SignalingServer | null = null
let client: SignalingClient | null = null

afterEach(async () => {
  await client?.close()
  await responder?.stop()
  await server?.stop()
  client = null
  responder = null
  server = null
})

interface Machine {
  token: string
  received: SignalMessage[]
  joined: string[]
}

async function bootMachine(token: string): Promise<Machine> {
  const machine: Machine = { token, received: [], joined: [] }

  const s = new SignalingServer({
    port: 0,
    secret: () => machine.token,
    hostName: 'HostBox',
    onClientAuthenticated: (name) => machine.joined.push(name),
    onMessage: (msg) => machine.received.push(msg),
    onClientGone: () => machine.joined.push('<gone>')
  })
  const port = await s.start()

  const r = new DiscoveryResponder({
    port: DISCOVERY_PORT,
    token: () => machine.token,
    beacon: () => ({ hostName: 'HostBox', port, platform: 'darwin' })
  })
  await r.start()

  server = s
  responder = r
  return machine
}

describe('connect by ID', () => {
  it('resolves the ID then authenticates with it', async () => {
    const machine = await bootMachine('123412341234')

    const found = await findHostByToken('123412341234', {
      port: DISCOVERY_PORT,
      timeoutMs: 800,
      broadcastAddress: LOOPBACK
    })
    expect(found).not.toBeNull()

    const events: string[] = []
    client = new SignalingClient({
      secret: '123412341234',
      clientName: 'LaptopBox',
      onConnected: (hostName) => events.push(`connected:${hostName}`),
      onMessage: () => undefined,
      onClosed: () => undefined
    })

    await client.connect(found!.address, found!.port)

    expect(events).toEqual(['connected:HostBox'])
    expect(machine.joined).toContain('LaptopBox')
  })

  it('does not find a machine once it regenerates its ID', async () => {
    const machine = await bootMachine('123412341234')
    machine.token = '555566667777'

    const found = await findHostByToken('123412341234', {
      port: DISCOVERY_PORT,
      timeoutMs: 600,
      broadcastAddress: LOOPBACK
    })

    expect(found).toBeNull()
  })

  it('refuses the handshake when the ID changed between discovery and connect', async () => {
    const machine = await bootMachine('123412341234')

    const found = await findHostByToken('123412341234', {
      port: DISCOVERY_PORT,
      timeoutMs: 800,
      broadcastAddress: LOOPBACK
    })
    expect(found).not.toBeNull()

    // The partner regenerates in the gap between resolve and connect.
    machine.token = '555566667777'

    client = new SignalingClient({
      secret: '123412341234',
      clientName: 'LaptopBox',
      onConnected: () => undefined,
      onMessage: () => undefined,
      onClosed: () => undefined
    })

    await expect(client.connect(found!.address, found!.port)).rejects.toThrow(/id|reject|auth/i)
    expect(machine.joined).not.toContain('LaptopBox')
  })
})
