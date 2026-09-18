import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { generateToken, normalizeToken } from '../shared/identity'

let cached: string | null = null

function identityFile(): string {
  return join(app.getPath('userData'), 'identity.json')
}

function persist(token: string): void {
  const file = identityFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ token }, null, 2), 'utf8')
}

/**
 * This machine's ID. Persisted so a partner who saved it can still reach you
 * after a restart; mint a new one with regenerateToken() to cut everyone off.
 */
export function getToken(): string {
  if (cached) return cached
  try {
    const raw = JSON.parse(readFileSync(identityFile(), 'utf8')) as { token?: unknown }
    const stored = typeof raw.token === 'string' ? normalizeToken(raw.token) : null
    if (stored) {
      cached = stored
      return stored
    }
  } catch {
    // First run, or the file was removed or corrupted. Mint a fresh ID below.
  }
  const token = generateToken()
  cached = token
  persist(token)
  return token
}

export function regenerateToken(): string {
  const token = generateToken()
  cached = token
  persist(token)
  return token
}
