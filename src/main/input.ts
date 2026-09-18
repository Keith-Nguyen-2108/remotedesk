import { Button, Key, Point, keyboard, mouse, screen } from '@nut-tree-fork/nut-js'
import { normalizedToScreenPixels, wheelDeltaToTicks, type Size } from '../shared/coords'
import { mapKeyCode } from '../shared/keymap'
import { parseInputMessage, parseJson, type InputMessage, type MouseButton } from '../shared/protocol'

// Default nut.js delays are tuned for scripted automation; we need them gone.
mouse.config.autoDelayMs = 0
keyboard.config.autoDelayMs = 0

const BUTTONS: Record<MouseButton, unknown> = {
  left: Button.LEFT,
  right: Button.RIGHT,
  middle: Button.MIDDLE
}

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
    await keyboard.releaseKey((Key as Record<string, never>)[name])
  }
  heldKeys.clear()
  for (const button of heldButtons) {
    await mouse.releaseButton(BUTTONS[button] as never)
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
      await mouse.pressButton(BUTTONS[msg.b] as never)
      return

    case 'up':
      await moveTo(msg.x, msg.y)
      heldButtons.delete(msg.b)
      await mouse.releaseButton(BUTTONS[msg.b] as never)
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
      if (!name) return
      heldKeys.add(name)
      await keyboard.pressKey((Key as Record<string, never>)[name])
      return
    }

    case 'keyup': {
      const name = mapKeyCode(msg.code)
      if (!name) return
      heldKeys.delete(name)
      await keyboard.releaseKey((Key as Record<string, never>)[name])
      return
    }
  }
}

/** Entry point for raw data-channel payloads - validates before touching the OS. */
export async function applyInputRaw(raw: string): Promise<void> {
  const msg = parseInputMessage(parseJson(raw))
  if (msg) await applyInput(msg)
}
