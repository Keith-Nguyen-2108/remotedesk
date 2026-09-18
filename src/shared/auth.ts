import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Fresh random challenge per connection attempt - this is what blocks replay. */
export function generateChallenge(): string {
  return randomBytes(32).toString('hex')
}

export function computeProof(secret: string, challenge: string): string {
  return createHmac('sha256', secret).update(challenge).digest('hex')
}

export function verifyProof(secret: string, challenge: string, proof: unknown): boolean {
  if (typeof proof !== 'string') return false
  const expected = Buffer.from(computeProof(secret, challenge), 'utf8')
  const given = Buffer.from(proof, 'utf8')
  if (expected.length !== given.length) return false
  return timingSafeEqual(expected, given)
}
