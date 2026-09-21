import type { IceCandidatePayload } from './protocol'

/** The slice of RTCPeerConnection this queue needs, so it stays testable. */
export interface IceTarget {
  addIceCandidate(init: {
    candidate: string
    sdpMid?: string
    sdpMLineIndex?: number
    usernameFragment?: string
  }): Promise<void>
}

/**
 * Holds ICE candidates until the peer connection can actually take them.
 *
 * Two real races make this necessary. ICE starts flowing the instant the
 * offerer calls setLocalDescription - which happens *before* the offer is put
 * on the wire - so the answerer can receive candidates for a connection it
 * has not built yet. And addIceCandidate rejects outright if it is called
 * before the remote description is applied. Without this queue both cases
 * silently discard candidates, and a session that negotiated perfectly can
 * still never connect.
 */
export class IceQueue {
  private pending: IceCandidatePayload[] = []
  private target: IceTarget | null = null

  /** The connection is ready (remote description applied): flush and go live. */
  async open(target: IceTarget): Promise<void> {
    this.target = target
    for (const payload of this.pending.splice(0)) {
      await this.deliver(payload)
    }
  }

  async add(payload: IceCandidatePayload): Promise<void> {
    if (!this.target) {
      this.pending.push(payload)
      return
    }
    await this.deliver(payload)
  }

  reset(): void {
    this.pending = []
    this.target = null
  }

  private async deliver(payload: IceCandidatePayload): Promise<void> {
    if (!this.target) return
    try {
      await this.target.addIceCandidate({
        candidate: payload.candidate,
        sdpMid: payload.sdpMid ?? undefined,
        sdpMLineIndex: payload.sdpMLineIndex ?? undefined,
        usernameFragment: payload.usernameFragment ?? undefined
      })
    } catch (err) {
      // One unusable candidate must not stop the rest from being tried.
      console.warn('ignored an ICE candidate:', err)
    }
  }
}
