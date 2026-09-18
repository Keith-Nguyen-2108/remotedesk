export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

const MAX_SCROLL_TICKS = 10
const PIXELS_PER_TICK = 100

/**
 * Convert a pointer position inside the video element into a 0..1 position on
 * the remote screen, undoing the `object-fit: contain` letterboxing.
 * Returns null when the point is in a black bar (nothing to click there).
 */
export function elementPointToNormalized(
  point: Point,
  element: Size,
  intrinsic: Size
): Point | null {
  if (element.width <= 0 || element.height <= 0) return null
  if (intrinsic.width <= 0 || intrinsic.height <= 0) return null

  const scale = Math.min(element.width / intrinsic.width, element.height / intrinsic.height)
  const displayedWidth = intrinsic.width * scale
  const displayedHeight = intrinsic.height * scale
  const offsetX = (element.width - displayedWidth) / 2
  const offsetY = (element.height - displayedHeight) / 2

  const x = (point.x - offsetX) / displayedWidth
  const y = (point.y - offsetY) / displayedHeight

  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (x < 0 || x > 1 || y < 0 || y > 1) return null
  return { x, y }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** Host side: turn a normalized position into an absolute pixel on this screen. */
export function normalizedToScreenPixels(normalized: Point, screen: Size): Point {
  return {
    x: Math.round(clamp(normalized.x, 0, 1) * (screen.width - 1)),
    y: Math.round(clamp(normalized.y, 0, 1) * (screen.height - 1))
  }
}

/** Browser wheel deltas are pixels; nut.js scrolls in ticks. */
export function wheelDeltaToTicks(delta: number): number {
  if (!Number.isFinite(delta) || delta === 0) return 0
  const raw = Math.round(Math.abs(delta) / PIXELS_PER_TICK)
  const magnitude = Math.min(Math.max(1, raw), MAX_SCROLL_TICKS)
  return delta > 0 ? magnitude : -magnitude
}
