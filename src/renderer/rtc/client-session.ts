import { IceQueue } from '../../shared/ice-queue'
import { parseSignalMessage, type InputMessage } from '../../shared/protocol'
import { createPeer, type PeerHandles, watchConnection } from './peer'

export interface ClientSessionCallbacks {
  onStatus: (text: string) => void
  onStream: (stream: MediaStream) => void
  onCtrlMessage: (raw: string) => void
  onFileChunk: (chunk: ArrayBuffer) => void
}

export class ClientSession {
  private peer: PeerHandles | null = null
  // Candidates routinely arrive before the offer does; holding them here is
  // what keeps the connection from silently failing to establish.
  private readonly ice = new IceQueue()

  constructor(private readonly cb: ClientSessionCallbacks) {}

  async handleSignal(raw: unknown): Promise<void> {
    const msg = parseSignalMessage(raw)
    if (!msg) return

    if (msg.t === 'offer') {
      this.stop()
      this.ice.reset()
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

      watchConnection(peer.pc, (text) => this.cb.onStatus(text))

      await peer.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp })
      await this.ice.open(peer.pc)
      const answer = await peer.pc.createAnswer()
      await peer.pc.setLocalDescription(answer)
      await window.rd.client.signal({ t: 'answer', sdp: answer.sdp ?? '' })
      this.cb.onStatus('answer sent')
      return
    }

    if (msg.t === 'ice') await this.ice.add(msg.candidate)
  }

  /** Input is the latency-critical path, so it gets its own channel. */
  sendInput(msg: InputMessage): void {
    const ch = this.peer?.channels.input
    if (ch?.readyState === 'open') ch.send(JSON.stringify(msg))
  }

  channel(name: 'input' | 'ctrl' | 'file'): RTCDataChannel | undefined {
    return this.peer?.channels[name]
  }

  stop(): void {
    this.ice.reset()
    this.peer?.pc.close()
    this.peer = null
  }
}
