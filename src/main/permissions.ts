import { shell, systemPreferences } from 'electron'

export type PermissionStatus = 'granted' | 'denied' | 'not-determined' | 'not-needed'

export interface PermissionState {
  platform: string
  screenRecording: PermissionStatus
  accessibility: PermissionStatus
  /** True when this machine can act as a host right now. */
  ready: boolean
}

const SCREEN_RECORDING_PANE =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
const ACCESSIBILITY_PANE =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'

function mapMediaStatus(status: string): PermissionStatus {
  if (status === 'granted') return 'granted'
  if (status === 'not-determined' || status === 'unknown') return 'not-determined'
  return 'denied'
}

export function getPermissionState(): PermissionState {
  if (process.platform !== 'darwin') {
    return {
      platform: process.platform,
      screenRecording: 'not-needed',
      accessibility: 'not-needed',
      ready: true
    }
  }

  const screenRecording = mapMediaStatus(systemPreferences.getMediaAccessStatus('screen'))
  // Passing false checks without showing the system prompt.
  const accessibility: PermissionStatus = systemPreferences.isTrustedAccessibilityClient(false)
    ? 'granted'
    : 'denied'

  return {
    platform: 'darwin',
    screenRecording,
    accessibility,
    ready: screenRecording === 'granted' && accessibility === 'granted'
  }
}

export async function openScreenRecordingSettings(): Promise<void> {
  await shell.openExternal(SCREEN_RECORDING_PANE)
}

export async function openAccessibilitySettings(): Promise<void> {
  await shell.openExternal(ACCESSIBILITY_PANE)
}

/** Shows the one-time system prompt for Accessibility. Harmless if already granted. */
export function promptAccessibility(): boolean {
  if (process.platform !== 'darwin') return true
  return systemPreferences.isTrustedAccessibilityClient(true)
}
