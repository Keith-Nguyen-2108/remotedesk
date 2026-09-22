import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Ships with the app so a fresh install is reachable from the internet without
 * anyone pasting a URL on every new machine. It is only a rendezvous point: it
 * sees SHA-256(id) and opaque bytes, never the ID, the screen or any input, so
 * publishing the address gives nothing away. Override it in the UI to point at
 * your own, or clear the field to turn internet mode off entirely.
 */
export const DEFAULT_RELAY_URL = 'wss://remotedesk-r8z9.onrender.com'

interface StoredSettings {
  /** null means "never configured" - fall back to the shipped default. */
  relayUrl: string | null
  /** Set once the user has explicitly chosen, including choosing "off". */
  relayConfigured: boolean
}

let cached: StoredSettings | null = null

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function load(): StoredSettings {
  if (cached) return cached
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), 'utf8')) as Partial<StoredSettings>
    const relayUrl = typeof raw.relayUrl === 'string' ? raw.relayUrl : null
    cached = {
      relayUrl,
      // An existing install that already has a URL saved counts as configured,
      // so upgrading never silently moves someone onto the default relay.
      relayConfigured: raw.relayConfigured === true || relayUrl !== null
    }
  } catch {
    cached = { relayUrl: null, relayConfigured: false }
  }
  return cached
}

function persist(): void {
  const file = settingsFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(cached, null, 2), 'utf8')
}

/**
 * The relay server address (e.g. "wss://relay.example.com") that lets this
 * machine be reached from outside the LAN. Empty/null means internet mode is
 * off and the app behaves exactly as it did LAN-only.
 */
export function getRelayUrl(): string | null {
  const settings = load()
  if (!settings.relayConfigured) return DEFAULT_RELAY_URL
  return settings.relayUrl
}

export function setRelayUrl(url: string | null): void {
  const trimmed = url?.trim() || null
  // Recorded as a deliberate choice either way: clearing the field means "no
  // internet mode", which must not be re-filled with the default next launch.
  cached = { relayUrl: trimmed, relayConfigured: true }
  persist()
}
