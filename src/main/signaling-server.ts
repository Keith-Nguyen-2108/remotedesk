import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { generateChallenge, verifyProof } from '../shared/auth'
import {
  AUTH_TIMEOUT_MS,
  PROTOCOL_VERSION,
  parseJson,
  parseSignalMessage,
  type SignalMessage
} from '../shared/protocol'

export const CLOSE_AUTH_FAILED = 4001
export const CLOSE_BUSY = 4002
export const CLOSE_BAD_VERSION = 4003
export const CLOSE_REJECTED = 4004

export interface SignalingServerOptions {
  /** 0 picks a free port; production uses DEFAULT_SIGNAL_PORT. */
  port: number
  pin: string
  hostName: string
  onClientAuthenticated: (clientName: string) => void
  onMessage: (msg: SignalMessage) => void
  onClientGone: () => void
  /** Optional human approval gate, applied after the PIN checks out. */
  approveClient?: (clientName: string) => Promise<boolean>
}

export class SignalingServer {
  private http: Server | null = null
  private wss: WebSocketServer | null = null
  private active: WebSocket | null = null

  constructor(private readonly opts: SignalingServerOptions) {}

  async start(): Promise<number> {
    const http = createServer()
    const wss = new WebSocketServer({ server: http })
    wss.on('connection', (ws) => this.handleConnection(ws))
    this.http = http
    this.wss = wss

    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(this.opts.port, '0.0.0.0', () => resolve())
    })
    return (http.address() as AddressInfo).port
  }

  hasClient(): boolean {
    return this.active !== null && this.active.readyState === WebSocket.OPEN
  }

  send(msg: SignalMessage): void {
    if (this.active?.readyState === WebSocket.OPEN) {
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

  private handleConnection(ws: WebSocket): void {
    if (this.hasClient()) {
      ws.close(CLOSE_BUSY, 'another client is connected')
      return
    }

    const challenge = generateChallenge()
    let authed = false

    const authTimer = setTimeout(() => {
      if (!authed) ws.close(CLOSE_AUTH_FAILED, 'auth timeout')
    }, AUTH_TIMEOUT_MS)

    ws.on('message', (data) => {
      const msg = parseSignalMessage(parseJson(data.toString()))

      if (!authed) {
        if (!msg || msg.t !== 'auth') {
          ws.close(CLOSE_AUTH_FAILED, 'auth required')
          return
        }
        if (msg.version !== PROTOCOL_VERSION) {
          ws.close(CLOSE_BAD_VERSION, `host speaks v${PROTOCOL_VERSION}`)
          return
        }
        if (!verifyProof(this.opts.pin, challenge, msg.proof)) {
          ws.close(CLOSE_AUTH_FAILED, 'wrong pin')
          return
        }

        const finish = (approved: boolean): void => {
          if (!approved) {
            ws.close(CLOSE_REJECTED, 'rejected by host')
            return
          }
          authed = true
          clearTimeout(authTimer)
          this.active = ws
          ws.send(JSON.stringify({ t: 'auth-ok' } satisfies SignalMessage))
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

    ws.on('close', () => {
      clearTimeout(authTimer)
      if (this.active === ws) {
        this.active = null
        this.opts.onClientGone()
      }
    })

    ws.on('error', () => ws.close())

    ws.send(
      JSON.stringify({
        t: 'challenge',
        challenge,
        hostName: this.opts.hostName,
        version: PROTOCOL_VERSION
      } satisfies SignalMessage)
    )
  }
}
