import { randomInt } from 'node:crypto'

export const TOKEN_DIGITS = 12

const DIGITS_ONLY = /^\d+$/
const NON_DIGITS = /[^0-9]/g

/**
 * A machine's identity. Twelve digits is short enough to read aloud or paste
 * into a chat, and long enough (10^12) that guessing one on a LAN is hopeless.
 * It doubles as the shared secret: it is never sent over the wire, only proved
 * via HMAC, so learning someone's ID requires them to hand it to you.
 */
export function generateToken(): string {
  return String(randomInt(0, 1_000_000_000_000)).padStart(TOKEN_DIGITS, '0')
}

/** Display form: 1234 5678 9012. */
export function formatToken(token: string): string {
  if (!DIGITS_ONLY.test(token) || token.length !== TOKEN_DIGITS) return token
  return `${token.slice(0, 4)} ${token.slice(4, 8)} ${token.slice(8)}`
}

/** Accepts whatever the user pasted; returns the bare digits or null. */
export function normalizeToken(input: string): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  // Only strip separators from something that is otherwise digits and spacing,
  // so "abc123..." is rejected rather than silently cleaned up.
  if (!/^[\d\s-]+$/.test(trimmed)) return null
  const digits = trimmed.replace(NON_DIGITS, '')
  return digits.length === TOKEN_DIGITS ? digits : null
}

export function isValidToken(input: string): boolean {
  return normalizeToken(input) !== null
}
