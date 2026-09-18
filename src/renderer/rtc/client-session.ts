import { parseSignalMessage } from '../../shared/protocol'
import { addIceCandidate, createPeer, type PeerHandles } from './peer'

export interface ClientSessionCallbacks {
  onStatus: (text: string) => void
  onStream: (stream: MediaStream) => void
  onCtrlMessage: (raw: string) => void
  onFileChunk: (chunk: ArrayBuffer) => void
}

export class ClientSession {
  private peer: PeerHandles | null = null

  constructor(private readonly cb: ClientSessionCallbacks) {}

  async handleSignal(raw: unknown): Promise<void> {
    const msg = parseSignalMessage(raw)
    if (!msg) return

    if (msg.t === 'offer') {
      this.stop()
      const peer = createPeer((candidate) => void window.rd.client.signal({ t: 'ice', candidate }))
      this.peer = peer

      peer.pc.ontrack = (event) => {
        const stream = event.streams[0]
        if (stream) this.cb.onStream(stream)
      }

      peer.pc.ondatachannel = (event) => {
        const ch = event.channel
        if (ch.label === 'input') peer.channels.input = ch
        if (ch.label === 'ctrl') {
          peer.channels.ctrl = ch
          ch.onmessage = (e) => this.cb.onCtrlMessage(String(e.data))
        }
        if (ch.label === 'file') {
          peer.channels.file = ch
          ch.binaryType = 'arraybuffer'
          ch.onmessage = (e) => {
            if (e.data instanceof ArrayBuffer) this.cb.onFileChunk(e.data)
          }
        }
      }

      peer.pc.onconnectionstatechange = () => this.cb.onStatus(`peer: ${peer.pc.connectionState}`)

      await peer.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp })
      const answer = await peer.pc.createAnswer()
      await peer.pc.setLocalDescription(answer)
      await window.rd.client.signal({ t: 'answer', sdp: answer.sdp ?? '' })
      this.cb.onStatus('answer sent')
      return
    }

    if (msg.t === 'ice' && this.peer) addIceCandidate(this.peer.pc, msg.candidate)
  }

  channel(name: 'input' | 'ctrl' | 'file'): RTCDataChannel | undefined {
    return this.peer?.channels[name]
  }

  stop(): void {
    this.peer?.pc.close()
    this.peer = null
  }
}
