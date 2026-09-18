import { elementPointToNormalized } from '../../shared/coords'
import type { InputMessage } from '../../shared/protocol'

export interface RemoteScreenOptions {
  send: (msg: InputMessage) => void
}

const STICKY_MODIFIERS = ['ShiftLeft', 'ControlLeft', 'AltLeft', 'MetaLeft']

/**
 * Owns the video element showing the remote desktop and translates local pointer
 * and keyboard events into normalized InputMessages. Capture is opt-in: nothing
 * is sent until setControlEnabled(true).
 */
export class RemoteScreen {
  readonly el: HTMLDivElement
  readonly video: HTMLVideoElement
  private controlEnabled = false
  private pendingMove: { x: number; y: number } | null = null
  private moveScheduled = false

  constructor(private readonly opts: RemoteScreenOptions) {
    this.el = document.createElement('div')
    this.el.className = 'remote-screen'
    this.video = document.createElement('video')
    this.video.autoplay = true
    this.video.playsInline = true
    this.video.muted = true
    this.video.tabIndex = 0
    this.el.append(this.video)
    this.attachListeners()
  }

  setStream(stream: MediaStream): void {
    this.video.srcObject = stream
  }

  clear(): void {
    this.video.srcObject = null
    this.setControlEnabled(false)
  }

  setControlEnabled(value: boolean): void {
    this.controlEnabled = value
    this.el.classList.toggle('controlling', value)
    if (value) this.video.focus()
  }

  isControlEnabled(): boolean {
    return this.controlEnabled
  }

  /** Pointer position to normalized remote position, or null if outside the image. */
  private normalize(event: PointerEvent | WheelEvent): { x: number; y: number } | null {
    const rect = this.video.getBoundingClientRect()
    return elementPointToNormalized(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      { width: rect.width, height: rect.height },
      { width: this.video.videoWidth, height: this.video.videoHeight }
    )
  }

  /** Coalesce moves to one per frame; a raw pointermove stream would flood the channel. */
  private queueMove(point: { x: number; y: number }): void {
    this.pendingMove = point
    if (this.moveScheduled) return
    this.moveScheduled = true
    requestAnimationFrame(() => {
      this.moveScheduled = false
      const move = this.pendingMove
      this.pendingMove = null
      if (move) this.opts.send({ t: 'move', x: move.x, y: move.y })
    })
  }

  private button(event: PointerEvent): 'left' | 'right' | 'middle' | null {
    if (event.button === 0) return 'left'
    if (event.button === 1) return 'middle'
    if (event.button === 2) return 'right'
    return null
  }

  private attachListeners(): void {
    this.video.addEventListener('pointermove', (event) => {
      if (!this.controlEnabled) return
      const point = this.normalize(event)
      if (point) this.queueMove(point)
    })

    this.video.addEventListener('pointerdown', (event) => {
      if (!this.controlEnabled) return
      const point = this.normalize(event)
      const button = this.button(event)
      if (!point || !button) return
      event.preventDefault()
      this.video.focus()
      this.opts.send({ t: 'down', b: button, x: point.x, y: point.y })
    })

    this.video.addEventListener('pointerup', (event) => {
      if (!this.controlEnabled) return
      const point = this.normalize(event)
      const button = this.button(event)
      if (!point || !button) return
      event.preventDefault()
      this.opts.send({ t: 'up', b: button, x: point.x, y: point.y })
    })

    this.video.addEventListener('contextmenu', (event) => {
      if (this.controlEnabled) event.preventDefault()
    })

    this.video.addEventListener(
      'wheel',
      (event) => {
        if (!this.controlEnabled) return
        event.preventDefault()
        this.opts.send({ t: 'wheel', dx: event.deltaX, dy: event.deltaY })
      },
      { passive: false }
    )

    this.video.addEventListener('keydown', (event) => {
      if (!this.controlEnabled) return
      event.preventDefault()
      this.opts.send({ t: 'keydown', code: event.code })
    })

    this.video.addEventListener('keyup', (event) => {
      if (!this.controlEnabled) return
      event.preventDefault()
      this.opts.send({ t: 'keyup', code: event.code })
    })

    // Losing focus must not leave modifiers stuck down on the remote machine.
    this.video.addEventListener('blur', () => {
      if (!this.controlEnabled) return
      for (const code of STICKY_MODIFIERS) this.opts.send({ t: 'keyup', code })
    })
  }
}
