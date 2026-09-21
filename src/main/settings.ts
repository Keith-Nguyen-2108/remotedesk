import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface StoredSettings {
  relayUrl: string | null
}

let cached: StoredSettings | null = null

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function load(): StoredSettings {
  if (cached) return cached
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), 'utf8')) as Partial<StoredSettings>
    cached = { relayUrl: typeof raw.relayUrl === 'string' ? raw.relayUrl : null }
  } catch {
    cached = { relayUrl: null }
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
  return load().relayUrl
}

export function setRelayUrl(url: string | null): void {
  const trimmed = url?.trim() || null
  cached = { relayUrl: trimmed }
  persist()
}
