import type { IceCandidatePayload } from '../../shared/protocol'

export interface PeerHandles {
  pc: RTCPeerConnection
  /** Set by the host (it creates the channels); filled on the client via ondatachannel. */
  channels: { input?: RTCDataChannel; ctrl?: RTCDataChannel; file?: RTCDataChannel }
}

export function createPeer(onIce: (candidate: IceCandidatePayload) => void): PeerHandles {
  // No STUN/TURN: LAN only in this plan. The internet plan adds ice servers here.
  const pc = new RTCPeerConnection({ iceServers: [] })
  const handles: PeerHandles = { pc, channels: {} }

  pc.onicecandidate = (event) => {
    if (!event.candidate) return
    onIce({
      candidate: event.candidate.candidate,
      sdpMid: event.candidate.sdpMid,
      sdpMLineIndex: event.candidate.sdpMLineIndex,
      usernameFragment: event.candidate.usernameFragment
    })
  }

  return handles
}

export function addIceCandidate(pc: RTCPeerConnection, payload: IceCandidatePayload): void {
  void pc.addIceCandidate({
    candidate: payload.candidate,
    sdpMid: payload.sdpMid ?? undefined,
    sdpMLineIndex: payload.sdpMLineIndex ?? undefined,
    usernameFragment: payload.usernameFragment ?? undefined
  })
}

/** Cap the screen stream so a busy desktop cannot saturate the link. */
export async function limitBitrate(sender: RTCRtpSender, maxBitrate: number): Promise<void> {
  const params = sender.getParameters()
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
  params.encodings[0]!.maxBitrate = maxBitrate
  await sender.setParameters(params)
}
