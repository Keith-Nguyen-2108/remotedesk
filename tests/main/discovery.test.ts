import { afterEach, describe, expect, it } from 'vitest'
import { DiscoveryResponder, queryHosts } from '../../src/main/discovery'

let responder: DiscoveryResponder | null = null

afterEach(async () => {
  await responder?.stop()
  responder = null
})

describe('discovery', () => {
  it('answers a query with the host beacon', async () => {
    const port = 45899
    responder = new DiscoveryResponder({
      port,
      beacon: () => ({ hostName: 'TestHost', port: 45789, platform: 'darwin' })
    })
    await responder.start()

    const hosts = await queryHosts({ port, timeoutMs: 600, broadcastAddress: '127.0.0.1' })

    expect(hosts).toHaveLength(1)
    expect(hosts[0]).toMatchObject({
      hostName: 'TestHost',
      port: 45789,
      platform: 'darwin',
      address: '127.0.0.1'
    })
  })

  it('returns an empty list when nothing is listening', async () => {
    const hosts = await queryHosts({ port: 45898, timeoutMs: 400, broadcastAddress: '127.0.0.1' })
    expect(hosts).toEqual([])
  })

  it('ignores traffic that is not our protocol', async () => {
    const port = 45897
    responder = new DiscoveryResponder({
      port,
      beacon: () => ({ hostName: 'TestHost', port: 45789, platform: 'darwin' })
    })
    await responder.start()

    const { createSocket } = await import('node:dgram')
    const sock = createSocket('udp4')
    const replies: string[] = []
    sock.on('message', (buf) => replies.push(buf.toString()))
    await new Promise<void>((resolve) => sock.bind(0, '127.0.0.1', () => resolve()))
    sock.send('hello?', port, '127.0.0.1')
    await new Promise((r) => setTimeout(r, 400))
    sock.close()

    expect(replies).toEqual([])
  })
})
