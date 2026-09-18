import { Button, Key, Point, keyboard, mouse, screen } from '@nut-tree-fork/nut-js'
import { normalizedToScreenPixels, wheelDeltaToTicks, type Size } from '../shared/coords'
import { mapKeyCode } from '../shared/keymap'
import { parseInputMessage, parseJson, type InputMessage, type MouseButton } from '../shared/protocol'

// Default nut.js delays are tuned for scripted automation; we need them gone.
mouse.config.autoDelayMs = 0
keyboard.config.autoDelayMs = 0

const BUTTONS: Record<MouseButton, Button> = {
  left: Button.LEFT,
  right: Button.RIGHT,
  middle: Button.MIDDLE
}

/**
 * keymap.ts returns Key member *names* so it stays free of the native import.
 * This is the one place that turns a name back into the enum value; an unknown
 * name resolves to undefined and the event is dropped.
 */
const KEY_BY_NAME = Key as unknown as Record<string, Key | undefined>

let enabled = false
let cachedScreen: Size | null = null
const heldKeys = new Set<string>()
const heldButtons = new Set<MouseButton>()

export function resetInputState(): void {
  enabled = false
  cachedScreen = null
  heldKeys.clear()
  heldButtons.clear()
}

/**
 * Turning input off also releases anything the remote peer was holding, so a
 * disconnect mid-drag or mid-Cmd cannot leave a key stuck down on this machine.
 */
export async function setInputEnabled(value: boolean): Promise<void> {
  if (enabled && !value) await releaseAll()
  enabled = value
  if (!value) cachedScreen = null
}

export function isInputEnabled(): boolean {
  return enabled
}

async function releaseAll(): Promise<void> {
  for (const name of heldKeys) {
    const key = KEY_BY_NAME[name]
    if (key !== undefined) await keyboard.releaseKey(key)
  }
  heldKeys.clear()
  for (const button of heldButtons) {
    await mouse.releaseButton(BUTTONS[button])
  }
  heldButtons.clear()
}

async function screenSize(): Promise<Size> {
  if (!cachedScreen) {
    cachedScreen = { width: await screen.width(), height: await screen.height() }
  }
  return cachedScreen
}

async function moveTo(x: number, y: number): Promise<void> {
  const px = normalizedToScreenPixels({ x, y }, await screenSize())
  await mouse.setPosition(new Point(px.x, px.y))
}

export async function applyInput(msg: InputMessage): Promise<void> {
  if (!enabled) return

  switch (msg.t) {
    case 'move':
      await moveTo(msg.x, msg.y)
      return

    case 'down':
      await moveTo(msg.x, msg.y)
      heldButtons.add(msg.b)
      await mouse.pressButton(BUTTONS[msg.b])
      return

    case 'up':
      await moveTo(msg.x, msg.y)
      heldButtons.delete(msg.b)
      await mouse.releaseButton(BUTTONS[msg.b])
      return

    case 'wheel': {
      const vertical = wheelDeltaToTicks(msg.dy)
      const horizontal = wheelDeltaToTicks(msg.dx)
      if (vertical > 0) await mouse.scrollDown(vertical)
      else if (vertical < 0) await mouse.scrollUp(-vertical)
      if (horizontal > 0) await mouse.scrollRight(horizontal)
      else if (horizontal < 0) await mouse.scrollLeft(-horizontal)
      return
    }

    case 'keydown': {
      const name = mapKeyCode(msg.code)
      const key = name === null ? undefined : KEY_BY_NAME[name]
      if (name === null || key === undefined) return
      heldKeys.add(name)
      await keyboard.pressKey(key)
      return
    }

    case 'keyup': {
      const name = mapKeyCode(msg.code)
      const key = name === null ? undefined : KEY_BY_NAME[name]
      if (name === null || key === undefined) return
      heldKeys.delete(name)
      await keyboard.releaseKey(key)
      return
    }
  }
}

/** Entry point for raw data-channel payloads - validates before touching the OS. */
export async function applyInputRaw(raw: string): Promise<void> {
  const msg = parseInputMessage(parseJson(raw))
  if (msg) await applyInput(msg)
}
