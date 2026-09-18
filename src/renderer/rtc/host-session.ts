import { parseSignalMessage } from '../../shared/protocol'
import { addIceCandidate, createPeer, limitBitrate, type PeerHandles } from './peer'

export interface HostSessionCallbacks {
  onStatus: (text: string) => void
  onInputMessage: (raw: string) => void
  onCtrlMessage: (raw: string) => void
  onFileChunk: (chunk: ArrayBuffer) => void
}

const MAX_SCREEN_BITRATE = 8_000_000

export class HostSession {
  private peer: PeerHandles | null = null
  private stream: MediaStream | null = null

  constructor(private readonly cb: HostSessionCallbacks) {}

  /** Called once a client has authenticated: capture the screen and offer it. */
  async start(): Promise<void> {
    this.stop()

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false
    })
    this.stream = stream
    const track = stream.getVideoTracks()[0]
    if (!track) throw new Error('no video track from getDisplayMedia')
    // 'detail' tells the encoder to favour text sharpness over motion smoothness.
    track.contentHint = 'detail'

    const peer = createPeer((candidate) => void window.rd.host.signal({ t: 'ice', candidate }))
    this.peer = peer

    peer.channels.input = peer.pc.createDataChannel('input', { ordered: true })
    peer.channels.ctrl = peer.pc.createDataChannel('ctrl', { ordered: true })
    peer.channels.file = peer.pc.createDataChannel('file', { ordered: true })
    peer.channels.file.binaryType = 'arraybuffer'

    peer.channels.input.onmessage = (e) => this.cb.onInputMessage(String(e.data))
    peer.channels.ctrl.onmessage = (e) => this.cb.onCtrlMessage(String(e.data))
    peer.channels.file.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) this.cb.onFileChunk(e.data)
    }

    const sender = peer.pc.addTrack(track, stream)
    await limitBitrate(sender, MAX_SCREEN_BITRATE)

    peer.pc.onconnectionstatechange = () => this.cb.onStatus(`peer: ${peer.pc.connectionState}`)

    const offer = await peer.pc.createOffer()
    await peer.pc.setLocalDescription(offer)
    await window.rd.host.signal({ t: 'offer', sdp: offer.sdp ?? '' })
    this.cb.onStatus('offer sent')
  }

  async handleSignal(raw: unknown): Promise<void> {
    const msg = parseSignalMessage(raw)
    if (!msg || !this.peer) return
    if (msg.t === 'answer') {
      await this.peer.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
      this.cb.onStatus('answer applied')
    } else if (msg.t === 'ice') {
      addIceCandidate(this.peer.pc, msg.candidate)
    }
  }

  channel(name: 'input' | 'ctrl' | 'file'): RTCDataChannel | undefined {
    return this.peer?.channels[name]
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.peer?.pc.close()
    this.peer = null
  }
}
