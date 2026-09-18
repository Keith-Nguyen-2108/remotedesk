import { describe, expect, it } from 'vitest'
import { computeProof, generateChallenge, verifyProof } from '../../src/shared/auth'

describe('generateChallenge', () => {
  it('returns 64 hex characters and never repeats', () => {
    const a = generateChallenge()
    const b = generateChallenge()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})

describe('computeProof / verifyProof', () => {
  it('is deterministic for the same pin and challenge', () => {
    const c = generateChallenge()
    expect(computeProof('123456', c)).toBe(computeProof('123456', c))
  })

  it('accepts the correct proof', () => {
    const c = generateChallenge()
    expect(verifyProof('123456', c, computeProof('123456', c))).toBe(true)
  })

  it('rejects a proof made with the wrong secret', () => {
    const c = generateChallenge()
    expect(verifyProof('123456', c, computeProof('654321', c))).toBe(false)
  })

  it('rejects a proof made for a different challenge (no replay)', () => {
    const proof = computeProof('123456', generateChallenge())
    expect(verifyProof('123456', generateChallenge(), proof)).toBe(false)
  })

  it('rejects garbage without throwing', () => {
    const c = generateChallenge()
    expect(verifyProof('123456', c, undefined)).toBe(false)
    expect(verifyProof('123456', c, 42)).toBe(false)
    expect(verifyProof('123456', c, '')).toBe(false)
    expect(verifyProof('123456', c, 'short')).toBe(false)
  })
})
