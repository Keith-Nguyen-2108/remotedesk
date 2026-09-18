export type ShareItem =
  | { id: string; kind: 'text'; text: string; receivedAt: number }
  | { id: string; kind: 'link'; url: string; receivedAt: number }
  | { id: string; kind: 'image'; dataUrl: string; receivedAt: number }
  | { id: string; kind: 'file'; name: string; path: string; receivedAt: number }

export type NewShareItem =
  | { kind: 'text'; text: string }
  | { kind: 'link'; url: string }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'file'; name: string; path: string }

export interface ShareListDeps {
  now: () => number
  id: () => string
}

const defaultDeps: ShareListDeps = {
  now: () => Date.now(),
  id: () => globalThis.crypto.randomUUID()
}

/**
 * In-memory history of things the other machine has shared with this one.
 * Deliberately not persisted anywhere - closing the app clears it, the same
 * as any other in-process state.
 */
export class ShareList {
  private items: ShareItem[] = []

  constructor(private readonly deps: ShareListDeps = defaultDeps) {}

  /** Newest first, so the most recent share is always at the top. */
  add(input: NewShareItem): ShareItem {
    const item = { ...input, id: this.deps.id(), receivedAt: this.deps.now() } as ShareItem
    this.items = [item, ...this.items]
    return item
  }

  all(): readonly ShareItem[] {
    return this.items
  }

  clear(): void {
    this.items = []
  }
}

const DATA_IMAGE_URL = /^data:image\/([a-zA-Z0-9.+-]+);base64,/

/** Extracts the image subtype ("png", "jpeg", "svg+xml", ...) from a data URL, or null. */
export function imageDataUrlSubtype(dataUrl: string): string | null {
  const match = DATA_IMAGE_URL.exec(dataUrl)
  return match ? match[1]!.toLowerCase() : null
}
