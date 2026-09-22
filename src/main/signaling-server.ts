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

    // Claim the failure path before ws can. Attaching a WebSocketServer to an
    // http server makes ws re-emit the server's 'error' on itself, and with
    // nothing listening there that unhandled 'error' derails the whole call:
    // listen() failures (a second copy of the app already holding the port,
    // most obviously) then never surface at all and this promise hangs
    // forever - taking the internet relay, set up further down the caller,
    // silently with it.
    const bound = new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(this.opts.port, '0.0.0.0', () => resolve())
    })

    const wss = new WebSocketServer({ server: http })
    wss.on('connection', (ws) => this.handleConnection(wrapWebSocket(ws)))
    wss.on('error', (err) => console.error('signaling websocket server error:', err))
    this.http = http
    this.wss = wss

    await bound
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
    // Deliberately leave `active` set: the onClose handler below clears it and
    // is what fires onClientGone, which is what actually stops screen capture
    // and input injection. Clearing it here makes that handler's identity
    // check fail, so an aborted session would keep sharing the screen.
    this.active.close(CLOSE_REJECTED, reason)
  }

  async stop(): Promise<void> {
    this.active = null
    const wss = this.wss
    const http = this.http
    this.wss = null
    this.http = null

    // Hang up on everyone first. A WebSocketServer that borrows an http server
    // does not disconnect its clients on close() - it waits for the last one
    // to leave before firing the callback, and http.close() likewise waits out
    // upgraded sockets. With a peer still connected neither callback ever
    // runs, so stop() never settles and every caller hangs with it, including
    // the startListening() restart behind saving a relay URL.
    if (wss) {
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
    if (http) {
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
  }

  private handleConnection(conn: WireConnection): void {
    if (this.hasClient()) {
      conn.close(CLOSE_BUSY, 'another client is connected')
      return
    }

    const challenge = generateChallenge()
    let authed = false
    let closed = false
    let awaitingApproval = false

    // The timeout is here to drop peers that never prove they know the ID. It
    // must not also run while a human decides on the approval dialog: ten
    // seconds is a realistic amount of time to notice and click Allow, and
    // firing then would close the connection out from under an approval that
    // is about to be granted.
    const authTimer = setTimeout(() => {
      if (!authed && !awaitingApproval) conn.close(CLOSE_AUTH_FAILED, 'auth timeout')
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
          awaitingApproval = false
          // The peer may be long gone by the time approval comes back. Going
          // ahead anyway would announce a client that is not there, and this
          // machine would start capturing its screen and accepting injected
          // input for a session nobody is on the other end of - with no close
          // event left to ever tear it back down.
          if (closed || !conn.isOpen) return
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
          awaitingApproval = true
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
      closed = true
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
