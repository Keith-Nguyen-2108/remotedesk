import { WebSocket } from 'ws'
import { computeProof } from '../shared/auth'
import {
  AUTH_TIMEOUT_MS,
  PROTOCOL_VERSION,
  parseJson,
  parseSignalMessage,
  type SignalMessage
} from '../shared/protocol'
import { CLOSE_AUTH_FAILED, CLOSE_BAD_VERSION, CLOSE_BUSY, CLOSE_REJECTED } from './signaling-server'
import { wrapWebSocket, type WireConnection } from './wire-socket'

export interface SignalingClientOptions {
  /** The partner machine's ID, which doubles as the shared secret. */
  secret: string
  clientName: string
  onConnected: (hostName: string) => void
  onMessage: (msg: SignalMessage) => void
  onClosed: (code: number, reason: string) => void
}

function describeClose(code: number, reason: string): string {
  if (reason) return reason
  switch (code) {
    case CLOSE_AUTH_FAILED:
      return 'the partner rejected this ID, or timed out'
    case CLOSE_BUSY:
      return 'the host already has a client connected'
    case CLOSE_BAD_VERSION:
      return 'app versions do not match - update both machines'
    case CLOSE_REJECTED:
      return 'the host rejected the session'
    default:
      return `connection closed (${code})`
  }
}

/**
 * Authenticates over an already-connected WireConnection. The LAN path opens
 * a direct WebSocket and wraps it; the internet path hands over a connection
 * a relay server has already paired with the target machine. Either way, the
 * PIN/token challenge-response from here on is identical.
 */
export class SignalingClient {
  private conn: WireConnection | null = null
  private authed = false
  private pendingHostName = 'host'

  constructor(private readonly opts: SignalingClientOptions) {}

  /** LAN transport: connect directly to a discovered address:port. */
  connect(host: string, port: number): Promise<void> {
    return this.attach(wrapWebSocket(new WebSocket(`ws://${host}:${port}`)))
  }

  /** Internet transport: attach to a connection an external relay already paired. */
  attach(conn: WireConnection): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.conn = conn

      const timer = setTimeout(() => {
        reject(new Error('timed out waiting for the host'))
        conn.close()
      }, AUTH_TIMEOUT_MS)

      conn.onMessage((data) => {
        const msg = parseSignalMessage(parseJson(data))
        if (!msg) return

        if (msg.t === 'challenge') {
          if (msg.version !== PROTOCOL_VERSION) {
            clearTimeout(timer)
            reject(new Error('app versions do not match - update both machines'))
            conn.close()
            return
          }
          this.pendingHostName = msg.hostName
          conn.send(
            JSON.stringify({
              t: 'auth',
              proof: computeProof(this.opts.secret, msg.challenge),
              clientName: this.opts.clientName,
              version: PROTOCOL_VERSION
            } satisfies SignalMessage)
          )
          return
        }

        if (msg.t === 'auth-ok') {
          clearTimeout(timer)
          this.authed = true
          this.opts.onConnected(this.pendingHostName)
          resolve()
          return
        }

        if (this.authed) this.opts.onMessage(msg)
      })

      conn.onClose((code, reason) => {
        clearTimeout(timer)
        const described = describeClose(code, reason)
        if (!this.authed) reject(new Error(described))
        else this.opts.onClosed(code, described)
        this.conn = null
      })
    })
  }

  send(msg: SignalMessage): void {
    if (this.authed && this.conn?.isOpen) {
      this.conn.send(JSON.stringify(msg))
    }
  }

  async close(): Promise<void> {
    const conn = this.conn
    this.conn = null
    this.authed = false
    if (!conn) return
    conn.close()
  }
}
