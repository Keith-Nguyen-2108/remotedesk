import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

/** Six-digit session PIN, shown on the host and typed on the client. */
export function generatePin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/** Fresh random challenge per connection attempt - this is what blocks replay. */
export function generateChallenge(): string {
  return randomBytes(32).toString('hex')
}

export function computeProof(pin: string, challenge: string): string {
  return createHmac('sha256', pin).update(challenge).digest('hex')
}

export function verifyProof(pin: string, challenge: string, proof: unknown): boolean {
  if (typeof proof !== 'string') return false
  const expected = Buffer.from(computeProof(pin, challenge), 'utf8')
  const given = Buffer.from(proof, 'utf8')
  if (expected.length !== given.length) return false
  return timingSafeEqual(expected, given)
}
