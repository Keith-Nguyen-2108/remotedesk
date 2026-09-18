import { describe, expect, it } from 'vitest'
import { Key } from '@nut-tree-fork/nut-js'
import { mapKeyCode, mappedKeyNames } from '../../src/shared/keymap'

describe('mapKeyCode', () => {
  it('maps letters, digits and function keys', () => {
    expect(mapKeyCode('KeyA')).toBe('A')
    expect(mapKeyCode('KeyZ')).toBe('Z')
    expect(mapKeyCode('Digit0')).toBe('Num0')
    expect(mapKeyCode('Digit9')).toBe('Num9')
    expect(mapKeyCode('F1')).toBe('F1')
    expect(mapKeyCode('F12')).toBe('F12')
  })

  it('maps modifiers to their sided nut.js names', () => {
    expect(mapKeyCode('ShiftLeft')).toBe('LeftShift')
    expect(mapKeyCode('ShiftRight')).toBe('RightShift')
    expect(mapKeyCode('ControlLeft')).toBe('LeftControl')
    expect(mapKeyCode('AltLeft')).toBe('LeftAlt')
    expect(mapKeyCode('MetaLeft')).toBe('LeftSuper')
    expect(mapKeyCode('MetaRight')).toBe('RightSuper')
  })

  it('distinguishes Return from the numpad Enter', () => {
    expect(mapKeyCode('Enter')).toBe('Return')
    expect(mapKeyCode('NumpadEnter')).toBe('Enter')
  })

  it('maps navigation, punctuation and numpad keys', () => {
    expect(mapKeyCode('ArrowUp')).toBe('Up')
    expect(mapKeyCode('Backspace')).toBe('Backspace')
    expect(mapKeyCode('Backquote')).toBe('Grave')
    expect(mapKeyCode('BracketLeft')).toBe('LeftBracket')
    expect(mapKeyCode('Numpad5')).toBe('NumPad5')
    expect(mapKeyCode('NumpadAdd')).toBe('Add')
  })

  it('returns null for unmapped or hostile codes', () => {
    expect(mapKeyCode('Fn')).toBeNull()
    expect(mapKeyCode('')).toBeNull()
    expect(mapKeyCode('__proto__')).toBeNull()
    expect(mapKeyCode('constructor')).toBeNull()
  })
})

describe('mapping integrity', () => {
  it('every mapped name exists in the real nut.js Key enum', () => {
    const keyNames = new Set(Object.keys(Key))
    const missing = mappedKeyNames().filter((name) => !keyNames.has(name))
    expect(missing).toEqual([])
  })
})
