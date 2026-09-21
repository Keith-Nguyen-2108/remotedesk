import type { WebSocket } from 'ws'

/**
 * A minimal, transport-agnostic view of a live message socket. The LAN path
 * wraps a direct `ws` connection; the internet path wraps a WebSocket that a
 * relay server has already paired with a specific peer. Everything above this
 * layer - the PIN/token challenge-response, single-active-session
 * enforcement, SDP/ICE relay - is written once against this interface and
 * has no idea which transport it is actually running over.
 */
export interface WireConnection {
  send(data: string): void
  close(code?: number, reason?: string): void
  readonly isOpen: boolean
  onMessage(cb: (data: string) => void): void
  onClose(cb: (code: number, reason: string) => void): void
}

/**
 * Adapts a real `ws` library socket to the WireConnection interface.
 *
 * Frames are buffered from the moment of wrapping until a consumer attaches.
 * That window is real and lossy over a relay: the peer starts talking as soon
 * as the relay pairs the two sockets, while this side is still threading the
 * connection up through async IPC before anything calls onMessage. A
 * WebSocket replays nothing to a listener attached later, so without this the
 * very first frame - the auth challenge - can vanish and the handshake then
 * just times out with no explanation.
 */
export function wrapWebSocket(ws: WebSocket): WireConnection {
  // A socket error on this side almost always precedes a close event, but
  // some environments never fire 'close' after 'error' - force it so callers
  // never wait forever on a socket that is actually dead.
  ws.on('error', () => ws.close())

  const pendingMessages: string[] = []
  let deliverMessage: ((data: string) => void) | null = null
  ws.on('message', (data) => {
    const text = data.toString()
    if (deliverMessage) deliverMessage(text)
    else pendingMessages.push(text)
  })

  const pendingCloses: Array<[number, string]> = []
  let deliverClose: ((code: number, reason: string) => void) | null = null
  ws.on('close', (code, reasonBuf) => {
    const reason = reasonBuf.toString()
    if (deliverClose) deliverClose(code, reason)
    else pendingCloses.push([code, reason])
  })

  return {
    send: (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data)
    },
    close: (code, reason) => ws.close(code, reason),
    get isOpen() {
      return ws.readyState === ws.OPEN
    },
    onMessage: (cb) => {
      deliverMessage = cb
      for (const text of pendingMessages.splice(0)) cb(text)
    },
    onClose: (cb) => {
      deliverClose = cb
      for (const [code, reason] of pendingCloses.splice(0)) cb(code, reason)
    }
  }
}
