import { describe, expect, it } from 'vitest'
import { formatToken, generateToken, isValidToken, normalizeToken } from '../../src/shared/identity'

describe('generateToken', () => {
  it('always returns exactly twelve digits', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateToken()).toMatch(/^\d{12}$/)
    }
  })

  it('is not constant', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateToken()))
    expect(seen.size).toBeGreaterThan(1)
  })
})

describe('formatToken', () => {
  it('groups digits into threes for readability', () => {
    expect(formatToken('123456789012')).toBe('1234 5678 9012')
  })

  it('leaves anything unexpected alone rather than mangling it', () => {
    expect(formatToken('123')).toBe('123')
  })
})

describe('normalizeToken', () => {
  it('accepts a plain twelve-digit string', () => {
    expect(normalizeToken('123456789012')).toBe('123456789012')
  })

  it('accepts the formatted form the user copied', () => {
    expect(normalizeToken('1234 5678 9012')).toBe('123456789012')
    expect(normalizeToken('1234-5678-9012')).toBe('123456789012')
    expect(normalizeToken('  1234 5678 9012  ')).toBe('123456789012')
  })

  it('rejects the wrong number of digits', () => {
    expect(normalizeToken('12345678901')).toBeNull()
    expect(normalizeToken('1234567890123')).toBeNull()
    expect(normalizeToken('')).toBeNull()
  })

  it('rejects anything that is not digits', () => {
    expect(normalizeToken('abcdefghijkl')).toBeNull()
    expect(normalizeToken('1234 5678 90ab')).toBeNull()
  })

  it('rejects non-string input', () => {
    expect(normalizeToken(undefined as unknown as string)).toBeNull()
  })
})

describe('isValidToken', () => {
  it('agrees with normalizeToken', () => {
    expect(isValidToken('123456789012')).toBe(true)
    expect(isValidToken('nope')).toBe(false)
  })
})
