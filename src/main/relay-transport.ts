import { WebSocket } from 'ws'
import { tokenRoutingKey } from '../shared/identity'
import { parseJson, PROTOCOL_VERSION } from '../shared/protocol'
import { wrapWebSocket, type WireConnection } from './wire-socket'

export const RELAY_CONNECT_TIMEOUT_MS = 10_000
const REGISTER_RETRY_MS = 3000

interface RelayControlMessage {
  t?: unknown
  reason?: unknown
}

function parseControl(raw: string): RelayControlMessage | null {
  const value = parseJson(raw)
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RelayControlMessage)
    : null
}

/**
 * Keeps this machine reachable from the internet without any port forwarding:
 * the connection to the relay is always outbound, which passes through
 * ordinary home/mobile NATs and firewalls without configuration. Every frame
 * received before pairing is relay bookkeeping; every frame after pairing is
 * an opaque SignalMessage forwarded straight through, so `onInbound` hands
 * off to the exact same code path that handles a LAN connection.
 */
export class RelayListener {
  private ws: WebSocket | null = null
  private stopped = true
  private retryTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly opts: {
      url: string
      token: () => string
      onInbound: (conn: WireConnection) => void
      onStatus: (text: string) => void
    }
  ) {}

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.ws?.close()
    this.ws = null
  }

  private connect(): void {
    let ws: WebSocket
    try {
      ws = new WebSocket(this.opts.url)
    } catch {
      this.scheduleRetry('could not reach the relay')
      return
    }
    this.ws = ws
    let paired = false

    ws.on('open', () => {
      this.opts.onStatus('registered with the relay - reachable from the internet')
      ws.send(
        JSON.stringify({
          t: 'register',
          keyHash: tokenRoutingKey(this.opts.token()),
          version: PROTOCOL_VERSION
        })
      )
    })

    ws.on('message', (data) => {
      if (paired) return
      const msg = parseControl(data.toString())
      if (msg?.t === 'paired') {
        paired = true
        this.opts.onInbound(wrapWebSocket(ws))
      }
    })

    ws.on('close', () => {
      this.ws = null
      if (this.stopped) return
      // A pairing that ran its course (the session ended normally) should
      // re-register almost immediately, so this machine stays reachable for
      // the next incoming connection; an actual connection failure backs off.
      if (paired) {
        this.opts.onStatus('session ended - re-registering with the relay')
        this.retryTimer = setTimeout(() => {
          if (!this.stopped) this.connect()
        }, 250)
        return
      }
      this.scheduleRetry('relay connection lost')
    })

    ws.on('error', () => ws.close())
  }

  private scheduleRetry(reason: string): void {
    this.opts.onStatus(`${reason} - retrying`)
    this.retryTimer = setTimeout(() => {
      if (!this.stopped) this.connect()
    }, REGISTER_RETRY_MS)
  }
}

/**
 * One-shot: ask the relay to pair us with whoever is currently registered
 * under this token. Resolves with a live WireConnection once paired - from
 * there, SignalingClient.attach() runs the same handshake as the LAN path.
 */
export function connectViaRelay(
  url: string,
  token: string,
  timeoutMs = RELAY_CONNECT_TIMEOUT_MS
): Promise<WireConnection> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }

    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('the relay did not respond in time'))
    }, timeoutMs)

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          t: 'connect-request',
          keyHash: tokenRoutingKey(token),
          version: PROTOCOL_VERSION
        })
      )
    })

    ws.on('message', (data) => {
      const msg = parseControl(data.toString())
      if (msg?.t === 'paired') {
        clearTimeout(timer)
        resolve(wrapWebSocket(ws))
      } else if (msg?.t === 'peer-offline') {
        clearTimeout(timer)
        ws.close()
        reject(new Error('that ID is not reachable through the relay right now'))
      } else if (msg?.t === 'bad-version') {
        clearTimeout(timer)
        ws.close()
        reject(new Error('the relay is running a different protocol version'))
      }
    })

    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(err instanceof Error ? err : new Error(String(err)))
    })

    ws.on('close', (code) => {
      clearTimeout(timer)
      reject(new Error(`relay connection closed (${code})`))
    })
  })
}
