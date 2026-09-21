import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'

/** Must match PROTOCOL_VERSION in src/shared/protocol.ts on the app side. */
export const PROTOCOL_VERSION = 1

const HEARTBEAT_MS = 25_000
const REGISTER_TIMEOUT_MS = 10_000

/**
 * WebSocket close codes are only resendable verbatim in 1000 or 3000-4999
 * (RFC 6455); a code like 1006 ("abnormal closure") is a purely local status
 * that can never appear in an actual close frame, so trying to resend it
 * throws. Anything outside the resendable range degrades to a generic code,
 * with the original reason string (if any) still passed through separately.
 */
function forwardableCloseCode(code: number): number {
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code
  return 4005
}

interface ControlMessage {
  t?: unknown
  keyHash?: unknown
  version?: unknown
}

function parseControl(raw: string): ControlMessage | null {
  try {
    const value: unknown = JSON.parse(raw)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as ControlMessage)
      : null
  } catch {
    return null
  }
}

/**
 * A dumb rendezvous point for machines that cannot reach each other directly
 * (different networks, e.g. different countries). Every connection to it is
 * outbound from the app's side, so neither machine needs a public IP or a
 * forwarded port - the same trick every "connect from anywhere" tool relies on.
 *
 * It matches a `register` (this machine is reachable under this key) with a
 * later `connect-request` for the same key, then gets out of the way and
 * pipes raw frames between the two sockets until either side disconnects.
 *
 * What it can and cannot see:
 * - It only ever receives `keyHash`, a SHA-256 of a machine's 12-digit ID
 *   (`tokenRoutingKey` in the app). It never receives the ID itself.
 * - Once paired, it forwards opaque bytes; it does not parse or understand
 *   the PIN/token challenge-response, screen video, input, or file transfers
 *   flowing through it, and can't authenticate as either side - that
 *   handshake proves knowledge of the real ID directly between the two
 *   peers, with the relay only ever able to observe encrypted frames from it.
 * - It can observe which key hashes are online and when a lookup for one
 *   happens - a stable pseudonymous identifier - but cannot connect its own
 *   admin to a live session without the actual ID.
 */
export class RelayServer {
  private http: Server | null = null
  private wss: WebSocketServer | null = null
  private waiting = new Map<string, WebSocket>()
  private allSockets = new Set<WebSocket>()
  private heartbeat: NodeJS.Timeout | null = null

  async start(port: number): Promise<number> {
    const http = createServer()
    const wss = new WebSocketServer({ server: http })
    wss.on('connection', (ws) => this.handleConnection(ws))
    this.http = http
    this.wss = wss

    // Idle WebSocket connections routed over the internet get dropped by
    // intermediate proxies/load balancers after 30-60s of silence, which a
    // long screen-share session can easily sit through once negotiation is
    // done. A protocol-level ping (ws replies with pong automatically) keeps
    // every open socket - waiting or already paired - from looking idle.
    this.heartbeat = setInterval(() => {
      for (const ws of this.allSockets) {
        if (ws.readyState === ws.OPEN) ws.ping()
      }
    }, HEARTBEAT_MS)

    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(port, '0.0.0.0', () => resolve())
    })
    return (http.address() as AddressInfo).port
  }

  /** How many machines are currently reachable through this relay. */
  waitingCount(): number {
    return this.waiting.size
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const ws of this.allSockets) ws.close()
    this.waiting.clear()
    this.allSockets.clear()
    const wss = this.wss
    const http = this.http
    this.wss = null
    this.http = null
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()))
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()))
  }

  private handleConnection(ws: WebSocket): void {
    this.allSockets.add(ws)
    ws.once('close', () => this.allSockets.delete(ws))

    let settled = false

    const idleTimer = setTimeout(() => {
      if (!settled) ws.close(4000, 'no registration received')
    }, REGISTER_TIMEOUT_MS)
    ws.once('close', () => clearTimeout(idleTimer))

    ws.once('message', (data) => {
      const msg = parseControl(data.toString())

      if (!msg || (msg.t !== 'register' && msg.t !== 'connect-request')) {
        ws.close(4000, 'expected register or connect-request')
        return
      }
      if (typeof msg.keyHash !== 'string' || msg.keyHash.length === 0) {
        ws.close(4000, 'missing keyHash')
        return
      }
      if (msg.version !== PROTOCOL_VERSION) {
        ws.send(JSON.stringify({ t: 'bad-version' }))
        ws.close(4003, 'protocol version mismatch')
        return
      }

      if (msg.t === 'register') {
        settled = true
        const keyHash = msg.keyHash
        // A fresh registration (e.g. after a reconnect) replaces a stale one.
        this.waiting.get(keyHash)?.close(4001, 'superseded by a new registration')
        this.waiting.set(keyHash, ws)
        ws.once('close', () => {
          if (this.waiting.get(keyHash) === ws) this.waiting.delete(keyHash)
        })
        return
      }

      // connect-request
      const target = this.waiting.get(msg.keyHash)
      if (!target || target.readyState !== target.OPEN) {
        ws.send(JSON.stringify({ t: 'peer-offline' }))
        ws.close(4004, 'no such peer')
        return
      }
      this.waiting.delete(msg.keyHash)
      settled = true
      this.pair(ws, target)
    })
  }

  /** Once paired, the relay is a dumb pipe: forward frames, propagate closes. */
  private pair(requester: WebSocket, listener: WebSocket): void {
    const notify = (ws: WebSocket): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'paired' }))
    }
    notify(requester)
    notify(listener)

    requester.on('message', (data) => {
      if (listener.readyState === listener.OPEN) listener.send(data)
    })
    listener.on('message', (data) => {
      if (requester.readyState === requester.OPEN) requester.send(data)
    })

    // Forward the REAL close code/reason (e.g. "wrong ID", CLOSE_BUSY) so the
    // far side sees exactly what the near side intended, same as a direct LAN
    // connection - not a generic "peer disconnected" that would hide why.
    requester.on('close', (code, reasonBuf) => {
      if (listener.readyState === listener.OPEN) {
        listener.close(forwardableCloseCode(code), reasonBuf.toString())
      }
    })
    listener.on('close', (code, reasonBuf) => {
      if (requester.readyState === requester.OPEN) {
        requester.close(forwardableCloseCode(code), reasonBuf.toString())
      }
    })
  }
}
