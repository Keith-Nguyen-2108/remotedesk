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

export interface SignalingClientOptions {
  host: string
  port: number
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

export class SignalingClient {
  private ws: WebSocket | null = null
  private authed = false
  private pendingHostName = 'host'

  constructor(private readonly opts: SignalingClientOptions) {}

  /** Resolves once auth-ok arrives; rejects with a human-readable reason otherwise. */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://${this.opts.host}:${this.opts.port}`)
      this.ws = ws

      const timer = setTimeout(() => {
        reject(new Error('timed out waiting for the host'))
        ws.close()
      }, AUTH_TIMEOUT_MS)

      ws.on('message', (data) => {
        const msg = parseSignalMessage(parseJson(data.toString()))
        if (!msg) return

        if (msg.t === 'challenge') {
          if (msg.version !== PROTOCOL_VERSION) {
            clearTimeout(timer)
            reject(new Error('app versions do not match - update both machines'))
            ws.close()
            return
          }
          this.pendingHostName = msg.hostName
          ws.send(
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

      ws.on('error', (err) => {
        clearTimeout(timer)
        if (!this.authed) reject(err instanceof Error ? err : new Error(String(err)))
      })

      ws.on('close', (code, reasonBuf) => {
        clearTimeout(timer)
        const reason = describeClose(code, reasonBuf.toString())
        if (!this.authed) reject(new Error(reason))
        else this.opts.onClosed(code, reason)
        this.ws = null
      })
    })
  }

  send(msg: SignalMessage): void {
    if (this.authed && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  async close(): Promise<void> {
    const ws = this.ws
    this.ws = null
    this.authed = false
    if (!ws) return
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve())
      ws.close()
      setTimeout(resolve, 500)
    })
  }
}
