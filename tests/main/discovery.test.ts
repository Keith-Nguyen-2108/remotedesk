import { afterEach, describe, expect, it } from 'vitest'
import { createSocket } from 'node:dgram'
import { DiscoveryResponder, findHostByToken } from '../../src/main/discovery'

let responder: DiscoveryResponder | null = null

afterEach(async () => {
  await responder?.stop()
  responder = null
})

const HOST_TOKEN = '111122223333'
const OTHER_TOKEN = '999988887777'

async function startResponder(port: number, token = HOST_TOKEN): Promise<void> {
  responder = new DiscoveryResponder({
    port,
    token: () => token,
    beacon: () => ({ hostName: 'TestHost', port: 45789, platform: 'darwin' })
  })
  await responder.start()
}

describe('findHostByToken', () => {
  it('finds the host whose token matches', async () => {
    const port = 45899
    await startResponder(port)

    const host = await findHostByToken(HOST_TOKEN, {
      port,
      timeoutMs: 600,
      broadcastAddress: '127.0.0.1'
    })

    expect(host).toMatchObject({
      hostName: 'TestHost',
      port: 45789,
      platform: 'darwin',
      address: '127.0.0.1'
    })
  })

  it('returns null when no host holds that token', async () => {
    const port = 45898
    await startResponder(port)

    const host = await findHostByToken(OTHER_TOKEN, {
      port,
      timeoutMs: 600,
      broadcastAddress: '127.0.0.1'
    })

    expect(host).toBeNull()
  })

  it('returns null when nothing is listening at all', async () => {
    const host = await findHostByToken(HOST_TOKEN, {
      port: 45897,
      timeoutMs: 400,
      broadcastAddress: '127.0.0.1'
    })
    expect(host).toBeNull()
  })
})

describe('DiscoveryResponder', () => {
  it('ignores traffic that is not our protocol', async () => {
    const port = 45896
    await startResponder(port)

    const sock = createSocket('udp4')
    const replies: string[] = []
    sock.on('message', (buf) => replies.push(buf.toString()))
    await new Promise<void>((resolve) => sock.bind(0, '127.0.0.1', () => resolve()))
    sock.send('hello?', port, '127.0.0.1')
    sock.send(JSON.stringify({ magic: 'something-else' }), port, '127.0.0.1')
    await new Promise((r) => setTimeout(r, 400))
    sock.close()

    expect(replies).toEqual([])
  })

  it('never puts the token on the wire', async () => {
    const port = 45895
    await startResponder(port)

    // Capture the query the client actually broadcasts.
    const sniffer = createSocket({ type: 'udp4', reuseAddr: true })
    const seen: string[] = []
    sniffer.on('message', (buf) => seen.push(buf.toString()))
    await new Promise<void>((resolve) => sniffer.bind(45894, '127.0.0.1', () => resolve()))

    await findHostByToken(HOST_TOKEN, {
      port: 45894,
      timeoutMs: 400,
      broadcastAddress: '127.0.0.1'
    })
    sniffer.close()

    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toContain(HOST_TOKEN)
    const query = JSON.parse(seen[0]!) as { nonce: string; proof: string }
    expect(query.nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(query.proof).toMatch(/^[0-9a-f]{64}$/)
  })
})
