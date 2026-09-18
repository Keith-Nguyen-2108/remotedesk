import { describe, expect, it } from 'vitest'
import { ShareList, imageDataUrlSubtype } from '../../src/shared/shares'

function makeDeps() {
  let idCounter = 0
  let clock = 1000
  return {
    now: () => clock++,
    id: () => `id-${idCounter++}`
  }
}

describe('ShareList', () => {
  it('adds an item with the injected id and timestamp', () => {
    const list = new ShareList(makeDeps())
    const item = list.add({ kind: 'text', text: 'hello' })
    expect(item).toEqual({ kind: 'text', text: 'hello', id: 'id-0', receivedAt: 1000 })
  })

  it('keeps newest first', () => {
    const list = new ShareList(makeDeps())
    const first = list.add({ kind: 'text', text: 'one' })
    const second = list.add({ kind: 'link', url: 'https://example.com' })
    expect(list.all()).toEqual([second, first])
  })

  it('supports every kind', () => {
    const list = new ShareList(makeDeps())
    list.add({ kind: 'text', text: 'hi' })
    list.add({ kind: 'link', url: 'https://example.com' })
    list.add({ kind: 'image', dataUrl: 'data:image/png;base64,AAAA' })
    list.add({ kind: 'file', name: 'a.pdf', path: '/tmp/a.pdf' })
    expect(list.all().map((i) => i.kind)).toEqual(['file', 'image', 'link', 'text'])
  })

  it('clear empties the list', () => {
    const list = new ShareList(makeDeps())
    list.add({ kind: 'text', text: 'x' })
    list.clear()
    expect(list.all()).toEqual([])
  })

  it('returned array is a snapshot, not a live view', () => {
    const list = new ShareList(makeDeps())
    const snapshot = list.all()
    list.add({ kind: 'text', text: 'x' })
    expect(snapshot).toEqual([])
  })

  it('uses real defaults when none are injected', () => {
    const list = new ShareList()
    const item = list.add({ kind: 'text', text: 'x' })
    expect(item.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(item.receivedAt).toBeGreaterThan(0)
  })
})

describe('imageDataUrlSubtype', () => {
  it('extracts the subtype from a well-formed data url', () => {
    expect(imageDataUrlSubtype('data:image/png;base64,AAAA')).toBe('png')
    expect(imageDataUrlSubtype('data:image/jpeg;base64,AAAA')).toBe('jpeg')
    expect(imageDataUrlSubtype('data:image/svg+xml;base64,AAAA')).toBe('svg+xml')
  })

  it('returns null for a non-image or malformed value', () => {
    expect(imageDataUrlSubtype('data:text/html,<script>')).toBeNull()
    expect(imageDataUrlSubtype('data:image/png,notbase64')).toBeNull()
    expect(imageDataUrlSubtype('not a data url')).toBeNull()
    expect(imageDataUrlSubtype('')).toBeNull()
  })
})
