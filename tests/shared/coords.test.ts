import { describe, expect, it } from 'vitest'
import {
  elementPointToNormalized,
  normalizedToScreenPixels,
  wheelDeltaToTicks
} from '../../src/shared/coords'

describe('elementPointToNormalized', () => {
  it('maps the centre of a same-size element to (0.5, 0.5)', () => {
    expect(
      elementPointToNormalized(
        { x: 800, y: 450 },
        { width: 1600, height: 900 },
        { width: 1600, height: 900 }
      )
    ).toEqual({ x: 0.5, y: 0.5 })
  })

  it('maps correctly when the element is a scaled-down copy', () => {
    expect(
      elementPointToNormalized(
        { x: 400, y: 225 },
        { width: 800, height: 450 },
        { width: 1600, height: 900 }
      )
    ).toEqual({ x: 0.5, y: 0.5 })
  })

  it('accounts for horizontal letterboxing (wide video in a square box)', () => {
    const element = { width: 1000, height: 1000 }
    const intrinsic = { width: 1000, height: 500 }
    expect(elementPointToNormalized({ x: 500, y: 500 }, element, intrinsic)).toEqual({
      x: 0.5,
      y: 0.5
    })
    expect(elementPointToNormalized({ x: 0, y: 250 }, element, intrinsic)).toEqual({ x: 0, y: 0 })
    expect(elementPointToNormalized({ x: 1000, y: 750 }, element, intrinsic)).toEqual({
      x: 1,
      y: 1
    })
  })

  it('returns null for a point inside the letterbox bar', () => {
    expect(
      elementPointToNormalized(
        { x: 500, y: 100 },
        { width: 1000, height: 1000 },
        { width: 1000, height: 500 }
      )
    ).toBeNull()
    expect(
      elementPointToNormalized(
        { x: 500, y: 900 },
        { width: 1000, height: 1000 },
        { width: 1000, height: 500 }
      )
    ).toBeNull()
  })

  it('accounts for vertical pillarboxing (tall video in a square box)', () => {
    const element = { width: 1000, height: 1000 }
    const intrinsic = { width: 500, height: 1000 }
    expect(elementPointToNormalized({ x: 250, y: 0 }, element, intrinsic)).toEqual({ x: 0, y: 0 })
    expect(elementPointToNormalized({ x: 100, y: 500 }, element, intrinsic)).toBeNull()
  })

  it('returns null when either size is degenerate', () => {
    expect(
      elementPointToNormalized({ x: 1, y: 1 }, { width: 0, height: 100 }, { width: 10, height: 10 })
    ).toBeNull()
    expect(
      elementPointToNormalized({ x: 1, y: 1 }, { width: 100, height: 100 }, { width: 0, height: 10 })
    ).toBeNull()
  })
})

describe('normalizedToScreenPixels', () => {
  it('maps the centre to the middle pixel', () => {
    expect(normalizedToScreenPixels({ x: 0.5, y: 0.5 }, { width: 1920, height: 1080 })).toEqual({
      x: 960,
      y: 540
    })
  })

  it('never returns a coordinate outside the screen', () => {
    expect(normalizedToScreenPixels({ x: 1, y: 1 }, { width: 1920, height: 1080 })).toEqual({
      x: 1919,
      y: 1079
    })
    expect(normalizedToScreenPixels({ x: 0, y: 0 }, { width: 1920, height: 1080 })).toEqual({
      x: 0,
      y: 0
    })
  })

  it('clamps hostile out-of-range input', () => {
    expect(normalizedToScreenPixels({ x: 5, y: -5 }, { width: 1920, height: 1080 })).toEqual({
      x: 1919,
      y: 0
    })
  })
})

describe('wheelDeltaToTicks', () => {
  it('converts pixel deltas into scroll ticks', () => {
    expect(wheelDeltaToTicks(0)).toBe(0)
    expect(wheelDeltaToTicks(100)).toBe(1)
    expect(wheelDeltaToTicks(120)).toBe(1)
    expect(wheelDeltaToTicks(250)).toBe(3)
    expect(wheelDeltaToTicks(-120)).toBe(-1)
  })

  it('still scrolls one tick for a tiny trackpad delta', () => {
    expect(wheelDeltaToTicks(5)).toBe(1)
    expect(wheelDeltaToTicks(-5)).toBe(-1)
  })

  it('caps a huge delta and ignores garbage', () => {
    expect(wheelDeltaToTicks(50_000)).toBe(10)
    expect(wheelDeltaToTicks(Number.NaN)).toBe(0)
  })
})
