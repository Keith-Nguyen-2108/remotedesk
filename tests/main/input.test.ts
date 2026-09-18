import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []

vi.mock('@nut-tree-fork/nut-js', () => {
  class Point {
    constructor(
      public x: number,
      public y: number
    ) {}
  }
  return {
    Point,
    Button: { LEFT: 'LEFT', RIGHT: 'RIGHT', MIDDLE: 'MIDDLE' },
    // Any property access returns the property name, so Key.A === 'A'.
    Key: new Proxy({}, { get: (_t, prop) => String(prop) }),
    screen: {
      width: async () => 1920,
      height: async () => 1080
    },
    mouse: {
      config: { autoDelayMs: 100 },
      setPosition: async (p: { x: number; y: number }) => {
        calls.push(`move(${p.x},${p.y})`)
      },
      pressButton: async (b: string) => {
        calls.push(`press(${b})`)
      },
      releaseButton: async (b: string) => {
        calls.push(`release(${b})`)
      },
      scrollUp: async (n: number) => {
        calls.push(`scrollUp(${n})`)
      },
      scrollDown: async (n: number) => {
        calls.push(`scrollDown(${n})`)
      },
      scrollLeft: async (n: number) => {
        calls.push(`scrollLeft(${n})`)
      },
      scrollRight: async (n: number) => {
        calls.push(`scrollRight(${n})`)
      }
    },
    keyboard: {
      config: { autoDelayMs: 100 },
      pressKey: async (k: string) => {
        calls.push(`keyDown(${k})`)
      },
      releaseKey: async (k: string) => {
        calls.push(`keyUp(${k})`)
      }
    }
  }
})

const { applyInputRaw, resetInputState, setInputEnabled } = await import('../../src/main/input')

beforeEach(async () => {
  calls.length = 0
  resetInputState()
  await setInputEnabled(true)
})

describe('applyInputRaw', () => {
  it('scales a normalized move to screen pixels', async () => {
    await applyInputRaw(JSON.stringify({ t: 'move', x: 0.5, y: 0.5 }))
    expect(calls).toEqual(['move(960,540)'])
  })

  it('translates mouse buttons', async () => {
    await applyInputRaw(JSON.stringify({ t: 'down', b: 'right', x: 0, y: 0 }))
    await applyInputRaw(JSON.stringify({ t: 'up', b: 'right', x: 0, y: 0 }))
    expect(calls).toEqual(['move(0,0)', 'press(RIGHT)', 'move(0,0)', 'release(RIGHT)'])
  })

  it('translates wheel deltas into the right scroll direction', async () => {
    await applyInputRaw(JSON.stringify({ t: 'wheel', dx: 0, dy: 120 }))
    await applyInputRaw(JSON.stringify({ t: 'wheel', dx: -200, dy: 0 }))
    expect(calls).toEqual(['scrollDown(1)', 'scrollLeft(2)'])
  })

  it('presses and releases mapped keys', async () => {
    await applyInputRaw(JSON.stringify({ t: 'keydown', code: 'ShiftLeft' }))
    await applyInputRaw(JSON.stringify({ t: 'keydown', code: 'KeyA' }))
    await applyInputRaw(JSON.stringify({ t: 'keyup', code: 'KeyA' }))
    await applyInputRaw(JSON.stringify({ t: 'keyup', code: 'ShiftLeft' }))
    expect(calls).toEqual(['keyDown(LeftShift)', 'keyDown(A)', 'keyUp(A)', 'keyUp(LeftShift)'])
  })

  it('ignores keys that are not in the map', async () => {
    await applyInputRaw(JSON.stringify({ t: 'keydown', code: 'Fn' }))
    expect(calls).toEqual([])
  })

  it('ignores malformed and out-of-range payloads', async () => {
    await applyInputRaw('{not json')
    await applyInputRaw(JSON.stringify({ t: 'move', x: 42, y: 0 }))
    await applyInputRaw(JSON.stringify({ t: 'exec', cmd: 'rm -rf /' }))
    expect(calls).toEqual([])
  })

  it('does nothing at all while input is disabled', async () => {
    await setInputEnabled(false)
    calls.length = 0
    await applyInputRaw(JSON.stringify({ t: 'move', x: 0.5, y: 0.5 }))
    await applyInputRaw(JSON.stringify({ t: 'keydown', code: 'KeyA' }))
    expect(calls).toEqual([])
  })

  it('releases every held key when input is disabled mid-session', async () => {
    await applyInputRaw(JSON.stringify({ t: 'keydown', code: 'ControlLeft' }))
    await applyInputRaw(JSON.stringify({ t: 'down', b: 'left', x: 0, y: 0 }))
    calls.length = 0
    await setInputEnabled(false)
    expect(calls).toEqual(['keyUp(LeftControl)', 'release(LEFT)'])
  })
})
