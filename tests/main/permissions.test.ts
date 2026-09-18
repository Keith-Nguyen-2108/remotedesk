import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
  mediaAccess: 'granted' as string,
  trusted: true,
  opened: [] as string[]
}

vi.mock('electron', () => ({
  systemPreferences: {
    getMediaAccessStatus: (_kind: string) => state.mediaAccess,
    isTrustedAccessibilityClient: (_prompt: boolean) => state.trusted
  },
  shell: {
    openExternal: async (url: string) => {
      state.opened.push(url)
    }
  }
}))

const { getPermissionState, openAccessibilitySettings, openScreenRecordingSettings } = await import(
  '../../src/main/permissions'
)

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

beforeEach(() => {
  state.mediaAccess = 'granted'
  state.trusted = true
  state.opened.length = 0
  setPlatform('darwin')
})

describe('getPermissionState on macOS', () => {
  it('reports both permissions as granted', () => {
    expect(getPermissionState()).toEqual({
      platform: 'darwin',
      screenRecording: 'granted',
      accessibility: 'granted',
      ready: true
    })
  })

  it('reports a missing screen recording grant', () => {
    state.mediaAccess = 'denied'
    const result = getPermissionState()
    expect(result.screenRecording).toBe('denied')
    expect(result.ready).toBe(false)
  })

  it('reports a missing accessibility grant', () => {
    state.trusted = false
    const result = getPermissionState()
    expect(result.accessibility).toBe('denied')
    expect(result.ready).toBe(false)
  })

  it('passes through the not-determined state', () => {
    state.mediaAccess = 'not-determined'
    expect(getPermissionState().screenRecording).toBe('not-determined')
  })
})

describe('getPermissionState on other platforms', () => {
  it('needs no permissions on Windows', () => {
    setPlatform('win32')
    expect(getPermissionState()).toEqual({
      platform: 'win32',
      screenRecording: 'not-needed',
      accessibility: 'not-needed',
      ready: true
    })
  })
})

describe('settings deep links', () => {
  it('opens the Screen Recording pane', async () => {
    await openScreenRecordingSettings()
    expect(state.opened[0]).toContain('Privacy_ScreenCapture')
  })

  it('opens the Accessibility pane', async () => {
    await openAccessibilitySettings()
    expect(state.opened[0]).toContain('Privacy_Accessibility')
  })
})
