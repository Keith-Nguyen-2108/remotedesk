import { describe, expect, it } from 'vitest'
import { computeProof, generateChallenge, generatePin, verifyProof } from '../../src/shared/auth'

describe('generatePin', () => {
  it('always returns exactly six digits', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePin()).toMatch(/^\d{6}$/)
    }
  })

  it('is not constant', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generatePin()))
    expect(seen.size).toBeGreaterThan(1)
  })
})

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

  it('rejects a proof made with the wrong pin', () => {
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
