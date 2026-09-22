import { createSocket, type Socket } from 'node:dgram'
import { computeProof, generateChallenge, verifyProof } from '../shared/auth'
import { DISCOVERY_MAGIC, DISCOVERY_PORT, PROTOCOL_VERSION, parseJson } from '../shared/protocol'

export interface HostBeacon {
  hostName: string
  port: number
  platform: string
}

export interface DiscoveredHost extends HostBeacon {
  address: string
}

interface DiscoveryQuery {
  magic: string
  version: number
  nonce: string
  proof: string
}

interface BeaconWire extends HostBeacon {
  magic: string
  version: number
}

/**
 * Runs on every machine so it can be reached by its ID.
 *
 * The query carries HMAC(token, nonce) rather than the token, so a machine
 * looking for a partner proves it already knows that ID without broadcasting
 * it. Only the holder of that ID can verify the proof, and everyone else stays
 * silent, which also means a sniffer on the LAN learns nothing reusable.
 */
export class DiscoveryResponder {
  private socket: Socket | null = null

  constructor(
    private readonly opts: {
      port?: number
      token: () => string
      beacon: () => HostBeacon
      /** Called if discovery dies after a successful bind. */
      onError?: (err: Error) => void
    }
  ) {}

  async start(): Promise<void> {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })

    socket.on('message', (buf, rinfo) => {
      const query = parseJson(buf.toString()) as Partial<DiscoveryQuery> | null
      if (!query || query.magic !== DISCOVERY_MAGIC || query.version !== PROTOCOL_VERSION) return
      if (typeof query.nonce !== 'string' || typeof query.proof !== 'string') return
      if (!verifyProof(this.opts.token(), query.nonce, query.proof)) return

      const wire: BeaconWire = {
        magic: DISCOVERY_MAGIC,
        version: PROTOCOL_VERSION,
        ...this.opts.beacon()
      }
      socket.send(JSON.stringify(wire), rinfo.port, rinfo.address)
    })

    await new Promise<void>((resolve, reject) => {
      socket.once('error', (err) => {
        // `this.socket` is not assigned yet, so stop() could not clean this up.
        socket.close()
        reject(err)
      })
      socket.bind(this.opts.port ?? DISCOVERY_PORT, () => resolve())
    })
    this.socket = socket

    // Past the bind, an error means this machine has quietly stopped answering
    // discovery. Report it rather than just shutting down unannounced.
    socket.on('error', (err) => {
      this.opts.onError?.(err)
      void this.stop()
    })
  }

  async stop(): Promise<void> {
    const socket = this.socket
    this.socket = null
    if (!socket) return
    await new Promise<void>((resolve) => socket.close(() => resolve()))
  }
}

/** Resolves an ID to a reachable address, or null if nobody on the LAN answers. */
export function findHostByToken(
  token: string,
  opts: { port?: number; timeoutMs?: number; broadcastAddress?: string } = {}
): Promise<DiscoveredHost | null> {
  const port = opts.port ?? DISCOVERY_PORT
  const timeoutMs = opts.timeoutMs ?? 1500
  const broadcastAddress = opts.broadcastAddress ?? '255.255.255.255'

  return new Promise((resolve) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    let settled = false

    const finish = (result: DiscoveredHost | null): void => {
      if (settled) return
      settled = true
      socket.close()
      resolve(result)
    }

    socket.on('message', (buf, rinfo) => {
      const wire = parseJson(buf.toString()) as Partial<BeaconWire> | null
      if (!wire || wire.magic !== DISCOVERY_MAGIC || wire.version !== PROTOCOL_VERSION) return
      if (typeof wire.hostName !== 'string' || typeof wire.port !== 'number') return
      finish({
        address: rinfo.address,
        hostName: wire.hostName,
        port: wire.port,
        platform: typeof wire.platform === 'string' ? wire.platform : 'unknown'
      })
    })

    socket.on('error', () => finish(null))

    socket.bind(0, () => {
      socket.setBroadcast(true)
      const nonce = generateChallenge()
      const query: DiscoveryQuery = {
        magic: DISCOVERY_MAGIC,
        version: PROTOCOL_VERSION,
        nonce,
        proof: computeProof(token, nonce)
      }
      socket.send(JSON.stringify(query), port, broadcastAddress)
      setTimeout(() => finish(null), timeoutMs)
    })
  })
}
