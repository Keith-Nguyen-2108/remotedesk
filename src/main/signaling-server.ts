import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { generateChallenge, verifyProof } from '../shared/auth'
import {
  AUTH_TIMEOUT_MS,
  PROTOCOL_VERSION,
  parseJson,
  parseSignalMessage,
  type SignalMessage
} from '../shared/protocol'
import { wrapWebSocket, type WireConnection } from './wire-socket'

export const CLOSE_AUTH_FAILED = 4001
export const CLOSE_BUSY = 4002
export const CLOSE_BAD_VERSION = 4003
export const CLOSE_REJECTED = 4004

export interface SignalingServerOptions {
  /** 0 picks a free port; production uses DEFAULT_SIGNAL_PORT. */
  port: number
  /** Read lazily: regenerating this machine's ID must take effect immediately. */
  secret: () => string
  hostName: string
  onClientAuthenticated: (clientName: string) => void
  onMessage: (msg: SignalMessage) => void
  onClientGone: () => void
  /** Optional human approval gate, applied after the PIN checks out. */
  approveClient?: (clientName: string) => Promise<boolean>
}

/**
 * Accepts inbound sessions for this machine's identity. The LAN transport
 * (a direct WebSocketServer on the local network) is built in; a second
 * transport - an internet relay - can feed already-paired connections into
 * the very same instance via `handleExternalConnection`, so "only one active
 * session at a time" and the whole auth/approve/relay flow are shared and
 * behave identically regardless of how the peer found this machine.
 */
export class SignalingServer {
  private http: Server | null = null
  private wss: WebSocketServer | null = null
  private active: WireConnection | null = null

  constructor(private readonly opts: SignalingServerOptions) {}

  async start(): Promise<number> {
    const http = createServer()
    const wss = new WebSocketServer({ server: http })
    wss.on('connection', (ws) => this.handleConnection(wrapWebSocket(ws)))
    this.http = http
    this.wss = wss

    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(this.opts.port, '0.0.0.0', () => resolve())
    })
    return (http.address() as AddressInfo).port
  }

  /** Entry point for a connection an internet relay has already paired to us. */
  handleExternalConnection(conn: WireConnection): void {
    this.handleConnection(conn)
  }

  hasClient(): boolean {
    return this.active !== null && this.active.isOpen
  }

  send(msg: SignalMessage): void {
    if (this.active?.isOpen) {
      this.active.send(JSON.stringify(msg))
    }
  }

  disconnectClient(reason: string): void {
    if (!this.active) return
    this.send({ t: 'bye', reason })
    this.active.close(CLOSE_REJECTED, reason)
    this.active = null
  }

  async stop(): Promise<void> {
    this.active = null
    const wss = this.wss
    const http = this.http
    this.wss = null
    this.http = null
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()))
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()))
  }

  private handleConnection(conn: WireConnection): void {
    if (this.hasClient()) {
      conn.close(CLOSE_BUSY, 'another client is connected')
      return
    }

    const challenge = generateChallenge()
    let authed = false

    const authTimer = setTimeout(() => {
      if (!authed) conn.close(CLOSE_AUTH_FAILED, 'auth timeout')
    }, AUTH_TIMEOUT_MS)

    conn.onMessage((data) => {
      const msg = parseSignalMessage(parseJson(data))

      if (!authed) {
        if (!msg || msg.t !== 'auth') {
          conn.close(CLOSE_AUTH_FAILED, 'auth required')
          return
        }
        if (msg.version !== PROTOCOL_VERSION) {
          conn.close(CLOSE_BAD_VERSION, `host speaks v${PROTOCOL_VERSION}`)
          return
        }
        if (!verifyProof(this.opts.secret(), challenge, msg.proof)) {
          conn.close(CLOSE_AUTH_FAILED, 'wrong ID')
          return
        }

        const finish = (approved: boolean): void => {
          if (!approved) {
            conn.close(CLOSE_REJECTED, 'rejected by host')
            return
          }
          authed = true
          clearTimeout(authTimer)
          this.active = conn
          conn.send(JSON.stringify({ t: 'auth-ok' } satisfies SignalMessage))
          this.opts.onClientAuthenticated(msg.clientName)
        }

        if (this.opts.approveClient) {
          void this.opts.approveClient(msg.clientName).then(finish, () => finish(false))
        } else {
          finish(true)
        }
        return
      }

      // Authenticated: silently drop anything we cannot parse.
      if (!msg) return
      if (msg.t === 'auth' || msg.t === 'auth-ok' || msg.t === 'challenge') return
      this.opts.onMessage(msg)
    })

    conn.onClose(() => {
      clearTimeout(authTimer)
      if (this.active === conn) {
        this.active = null
        this.opts.onClientGone()
      }
    })

    conn.send(
      JSON.stringify({
        t: 'challenge',
        challenge,
        hostName: this.opts.hostName,
        version: PROTOCOL_VERSION
      } satisfies SignalMessage)
    )
  }
}
