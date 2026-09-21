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

/** Adapts a real `ws` library socket to the WireConnection interface. */
export function wrapWebSocket(ws: WebSocket): WireConnection {
  // A socket error on this side almost always precedes a close event, but
  // some environments never fire 'close' after 'error' - force it so callers
  // never wait forever on a socket that is actually dead.
  ws.on('error', () => ws.close())

  return {
    send: (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data)
    },
    close: (code, reason) => ws.close(code, reason),
    get isOpen() {
      return ws.readyState === ws.OPEN
    },
    onMessage: (cb) => ws.on('message', (data) => cb(data.toString())),
    onClose: (cb) => ws.on('close', (code, reasonBuf) => cb(code, reasonBuf.toString()))
  }
}
