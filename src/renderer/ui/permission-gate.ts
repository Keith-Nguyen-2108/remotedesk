interface PermissionState {
  platform: string
  screenRecording: 'granted' | 'denied' | 'not-determined' | 'not-needed'
  accessibility: 'granted' | 'denied' | 'not-determined' | 'not-needed'
  ready: boolean
}

const RECHECK_INTERVAL_MS = 2000

/**
 * macOS blocks both screen capture and input injection until the user grants
 * them by hand, and a relaunch is required afterwards. This panel explains that
 * and re-checks on a timer so the state updates as soon as the user flips the
 * switches in System Settings.
 */
export class PermissionGate {
  readonly el: HTMLElement
  private timer: number | null = null

  constructor(private readonly onReadyChange: (ready: boolean) => void) {
    this.el = document.createElement('div')
    this.el.className = 'permission-gate'
    this.el.hidden = true
    this.el.innerHTML = `
      <h3>This Mac needs two permissions</h3>
      <ul>
        <li>
          <span id="pg-screen-state">checking...</span> Screen Recording
          <button id="pg-screen-open">Open settings</button>
        </li>
        <li>
          <span id="pg-access-state">checking...</span> Accessibility
          <button id="pg-access-open">Open settings</button>
        </li>
      </ul>
      <p class="hint">
        Enable RemoteDesk in both lists, then quit and reopen the app - macOS only
        applies these grants on relaunch.
      </p>
    `

    this.el.querySelector<HTMLButtonElement>('#pg-screen-open')!.onclick = () =>
      void window.rd.permissions.openScreen()
    this.el.querySelector<HTMLButtonElement>('#pg-access-open')!.onclick = () => {
      // Triggers the system prompt the first time, then opens the pane.
      void window.rd.permissions.promptAccessibility()
      void window.rd.permissions.openAccessibility()
    }
  }

  start(): void {
    void this.refresh()
    if (this.timer === null) {
      this.timer = window.setInterval(() => void this.refresh(), RECHECK_INTERVAL_MS)
    }
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
  }

  private async refresh(): Promise<void> {
    const state = (await window.rd.permissions.get()) as PermissionState
    if (state.platform !== 'darwin') {
      this.el.hidden = true
      this.onReadyChange(true)
      return
    }

    const mark = (status: string): string => (status === 'granted' ? 'OK' : 'MISSING')
    this.el.querySelector<HTMLElement>('#pg-screen-state')!.textContent = mark(
      state.screenRecording
    )
    this.el.querySelector<HTMLElement>('#pg-access-state')!.textContent = mark(state.accessibility)
    this.el.hidden = state.ready
    this.onReadyChange(state.ready)
  }
}
