import type { IceCandidatePayload } from '../../shared/protocol'

export interface PeerHandles {
  pc: RTCPeerConnection
  /** Set by the host (it creates the channels); filled on the client via ondatachannel. */
  channels: { input?: RTCDataChannel; ctrl?: RTCDataChannel; file?: RTCDataChannel }
}

// Public STUN servers are free and need nothing hosted by this app: they only
// tell a peer its own public address/port so a router's NAT can be punched
// through for a direct P2P connection. They see none of the call's traffic.
// A restrictive/symmetric NAT that STUN cannot get through still needs a TURN
// relay, which does carry real bandwidth and is not included here - see
// server/README.md.
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
]

export function createPeer(
  onIce: (candidate: IceCandidatePayload) => void,
  iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS
): PeerHandles {
  const pc = new RTCPeerConnection({ iceServers })
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
