/**
 * Maps a browser KeyboardEvent.code (physical key identity) to the *name* of a
 * nut.js Key enum member. Returning a name instead of the enum value keeps this
 * module free of the native nut.js import, so it can run anywhere.
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function buildTable(): Record<string, string> {
  const table: Record<string, string> = {
    // modifiers
    ShiftLeft: 'LeftShift',
    ShiftRight: 'RightShift',
    ControlLeft: 'LeftControl',
    ControlRight: 'RightControl',
    AltLeft: 'LeftAlt',
    AltRight: 'RightAlt',
    MetaLeft: 'LeftSuper',
    MetaRight: 'RightSuper',
    CapsLock: 'CapsLock',

    // editing / navigation
    Enter: 'Return',
    NumpadEnter: 'Enter',
    Escape: 'Escape',
    Space: 'Space',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',

    // punctuation
    Backquote: 'Grave',
    Minus: 'Minus',
    Equal: 'Equal',
    BracketLeft: 'LeftBracket',
    BracketRight: 'RightBracket',
    Backslash: 'Backslash',
    Semicolon: 'Semicolon',
    Quote: 'Quote',
    Comma: 'Comma',
    Period: 'Period',
    Slash: 'Slash',

    // numpad operators
    NumpadAdd: 'Add',
    NumpadSubtract: 'Subtract',
    NumpadMultiply: 'Multiply',
    NumpadDivide: 'Divide',
    NumpadDecimal: 'Decimal',

    // system
    PrintScreen: 'Print',
    ScrollLock: 'ScrollLock',
    Pause: 'Pause',
    NumLock: 'NumLock',
    AudioVolumeMute: 'AudioMute',
    AudioVolumeDown: 'AudioVolDown',
    AudioVolumeUp: 'AudioVolUp'
  }

  for (const letter of LETTERS) table[`Key${letter}`] = letter
  for (let i = 0; i <= 9; i++) {
    table[`Digit${i}`] = `Num${i}`
    table[`Numpad${i}`] = `NumPad${i}`
  }
  for (let i = 1; i <= 12; i++) table[`F${i}`] = `F${i}`

  return table
}

const TABLE = buildTable()

export function mapKeyCode(code: string): string | null {
  // Own-property check only: a code of "__proto__" must not resolve to anything.
  if (!Object.prototype.hasOwnProperty.call(TABLE, code)) return null
  return TABLE[code] ?? null
}

export function mappedKeyNames(): string[] {
  return Object.values(TABLE)
}
