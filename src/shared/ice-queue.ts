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
  /** Bumped by reset(); lets a late open() recognise that it is stale. */
  private generation = 0

  /**
   * The connection is ready (remote description applied): flush and go live.
   *
   * Callers reach this after several awaits, so two overlapping offers can
   * arrive here out of order - the older one last, pointing at a peer that has
   * since been torn down. Binding to that peer would send every later
   * candidate into a closed connection, which fails silently and leaves a
   * session that negotiated cleanly but never connects.
   */
  async open(target: IceTarget): Promise<void> {
    const generation = this.generation
    this.target = target
    for (const payload of this.pending.splice(0)) {
      if (generation !== this.generation) return
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
    this.generation += 1
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
