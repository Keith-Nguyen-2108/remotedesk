import { createSocket, type Socket } from 'node:dgram'
import { DISCOVERY_MAGIC, DISCOVERY_PORT, PROTOCOL_VERSION, parseJson } from '../shared/protocol'

export interface HostBeacon {
  hostName: string
  port: number
  platform: string
}

export interface DiscoveredHost extends HostBeacon {
  address: string
}

interface BeaconWire extends HostBeacon {
  magic: string
  version: number
}

/** Runs on the host: replies to discovery queries while sharing is enabled. */
export class DiscoveryResponder {
  private socket: Socket | null = null

  constructor(private readonly opts: { port?: number; beacon: () => HostBeacon }) {}

  async start(): Promise<void> {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    socket.on('message', (buf, rinfo) => {
      if (buf.toString() !== DISCOVERY_MAGIC) return
      const beacon = this.opts.beacon()
      const wire: BeaconWire = { magic: DISCOVERY_MAGIC, version: PROTOCOL_VERSION, ...beacon }
      socket.send(JSON.stringify(wire), rinfo.port, rinfo.address)
    })
    socket.on('error', () => void this.stop())

    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(this.opts.port ?? DISCOVERY_PORT, () => resolve())
    })
    this.socket = socket
  }

  async stop(): Promise<void> {
    const socket = this.socket
    this.socket = null
    if (!socket) return
    await new Promise<void>((resolve) => socket.close(() => resolve()))
  }
}

/** Runs on the client: broadcasts one query and collects replies until the timeout. */
export function queryHosts(
  opts: { port?: number; timeoutMs?: number; broadcastAddress?: string } = {}
): Promise<DiscoveredHost[]> {
  const port = opts.port ?? DISCOVERY_PORT
  const timeoutMs = opts.timeoutMs ?? 1200
  const broadcastAddress = opts.broadcastAddress ?? '255.255.255.255'

  return new Promise((resolve) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    const found = new Map<string, DiscoveredHost>()

    socket.on('message', (buf, rinfo) => {
      const wire = parseJson(buf.toString()) as Partial<BeaconWire> | null
      if (!wire || wire.magic !== DISCOVERY_MAGIC || wire.version !== PROTOCOL_VERSION) return
      if (typeof wire.hostName !== 'string' || typeof wire.port !== 'number') return
      found.set(`${rinfo.address}:${wire.port}`, {
        address: rinfo.address,
        hostName: wire.hostName,
        port: wire.port,
        platform: typeof wire.platform === 'string' ? wire.platform : 'unknown'
      })
    })

    socket.on('error', () => {
      socket.close()
      resolve([])
    })

    socket.bind(0, () => {
      socket.setBroadcast(true)
      socket.send(DISCOVERY_MAGIC, port, broadcastAddress)
      setTimeout(() => {
        socket.close()
        resolve([...found.values()])
      }, timeoutMs)
    })
  })
}
