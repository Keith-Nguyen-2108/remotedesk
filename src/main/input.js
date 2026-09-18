// Mouse + keyboard injection on the host (controlled) machine via nut.js.
// Loaded lazily so a machine that only acts as a controller never needs it.

let nut = null;
function lib() {
  if (!nut) {
    // eslint-disable-next-line global-require
    nut = require('@nut-tree-fork/nut-js');
    nut.mouse.config.autoDelayMs = 0;
    nut.keyboard.config.autoDelayMs = 0;
  }
  return nut;
}

// Map browser KeyboardEvent.code -> nut.js Key
function toKey(code) {
  const { Key } = lib();
  const map = {
    Escape: Key.Escape, Enter: Key.Enter, Tab: Key.Tab, Space: Key.Space,
    Backspace: Key.Backspace, Delete: Key.Delete, Home: Key.Home, End: Key.End,
    PageUp: Key.PageUp, PageDown: Key.PageDown,
    ArrowLeft: Key.Left, ArrowRight: Key.Right, ArrowUp: Key.Up, ArrowDown: Key.Down,
    ShiftLeft: Key.LeftShift, ShiftRight: Key.RightShift,
    ControlLeft: Key.LeftControl, ControlRight: Key.RightControl,
    AltLeft: Key.LeftAlt, AltRight: Key.RightAlt,
    MetaLeft: Key.LeftSuper, MetaRight: Key.RightSuper,
    CapsLock: Key.CapsLock,
    F1: Key.F1, F2: Key.F2, F3: Key.F3, F4: Key.F4, F5: Key.F5, F6: Key.F6,
    F7: Key.F7, F8: Key.F8, F9: Key.F9, F10: Key.F10, F11: Key.F11, F12: Key.F12,
    Minus: Key.Minus, Equal: Key.Equal, BracketLeft: Key.LeftBracket,
    BracketRight: Key.RightBracket, Backslash: Key.Backslash, Semicolon: Key.Semicolon,
    Quote: Key.Quote, Comma: Key.Comma, Period: Key.Period, Slash: Key.Slash,
    Backquote: Key.Grave
  };
  if (map[code]) return map[code];
  if (/^Key([A-Z])$/.test(code)) return Key[code.slice(3)];
  if (/^Digit([0-9])$/.test(code)) return Key['Num' + code.slice(5)];
  if (/^Numpad([0-9])$/.test(code)) return Key['NumPad' + code.slice(6)];
  return null;
}

function toButton(btn) {
  const { Button } = lib();
  if (btn === 2) return Button.RIGHT;
  if (btn === 1) return Button.MIDDLE;
  return Button.LEFT;
}

// event: normalized coords {nx, ny in 0..1} scaled to the host's screen
async function inject(event, screen) {
  const { mouse, keyboard, Point } = lib();
  const w = screen.width;
  const h = screen.height;
  switch (event.t) {
    case 'move':
      await mouse.setPosition(new Point(Math.round(event.nx * w), Math.round(event.ny * h)));
      break;
    case 'down':
      await mouse.setPosition(new Point(Math.round(event.nx * w), Math.round(event.ny * h)));
      await mouse.pressButton(toButton(event.b));
      break;
    case 'up':
      await mouse.releaseButton(toButton(event.b));
      break;
    case 'dblclick':
      await mouse.setPosition(new Point(Math.round(event.nx * w), Math.round(event.ny * h)));
      await mouse.doubleClick(toButton(event.b));
      break;
    case 'scroll':
      if (event.dy) await (event.dy > 0 ? mouse.scrollDown(Math.abs(event.dy)) : mouse.scrollUp(Math.abs(event.dy)));
      if (event.dx) await (event.dx > 0 ? mouse.scrollRight(Math.abs(event.dx)) : mouse.scrollLeft(Math.abs(event.dx)));
      break;
    case 'keydown': {
      const k = toKey(event.code);
      if (k != null) await keyboard.pressKey(k);
      break;
    }
    case 'keyup': {
      const k = toKey(event.code);
      if (k != null) await keyboard.releaseKey(k);
      break;
    }
    case 'type':
      if (event.text) await keyboard.type(event.text);
      break;
    default:
      break;
  }
}

module.exports = { inject };
