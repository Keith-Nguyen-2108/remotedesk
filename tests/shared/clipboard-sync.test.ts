import { beforeEach, describe, expect, it } from 'vitest'
import { ClipboardSync, type ClipSnapshot } from '../../src/shared/clipboard-sync'

let local: ClipSnapshot | null
let writes: ClipSnapshot[]
let sync: ClipboardSync

beforeEach(() => {
  local = { kind: 'text', text: 'initial' }
  writes = []
  sync = new ClipboardSync({
    read: () => local,
    write: (snapshot) => {
      writes.push(snapshot)
      local = snapshot
    }
  })
})

describe('ClipboardSync', () => {
  it('does not push whatever was already on the clipboard at startup', () => {
    expect(sync.poll()).toBeNull()
  })

  it('pushes the clipboard after a local copy', () => {
    sync.poll()
    local = { kind: 'text', text: 'copied by me' }
    expect(sync.poll()).toEqual({ kind: 'text', text: 'copied by me' })
  })

  it('reports nothing while the clipboard is unchanged', () => {
    sync.poll()
    local = { kind: 'text', text: 'copied by me' }
    expect(sync.poll()).not.toBeNull()
    expect(sync.poll()).toBeNull()
    expect(sync.poll()).toBeNull()
  })

  it('writes a remote snapshot locally', () => {
    sync.poll()
    sync.applyRemote({ kind: 'text', text: 'from peer' })
    expect(writes).toEqual([{ kind: 'text', text: 'from peer' }])
  })

  it('never echoes a remote snapshot back to the peer', () => {
    sync.poll()
    sync.applyRemote({ kind: 'text', text: 'from peer' })
    expect(sync.poll()).toBeNull()
  })

  it('pushes again after a local copy that follows a remote write', () => {
    sync.poll()
    sync.applyRemote({ kind: 'text', text: 'from peer' })
    local = { kind: 'text', text: 'mine again' }
    expect(sync.poll()).toEqual({ kind: 'text', text: 'mine again' })
  })

  it('handles images by data url', () => {
    sync.poll()
    local = { kind: 'image', dataUrl: 'data:image/png;base64,AAAA' }
    expect(sync.poll()).toEqual({ kind: 'image', dataUrl: 'data:image/png;base64,AAAA' })
    expect(sync.poll()).toBeNull()
  })

  it('skips text larger than the limit instead of flooding the channel', () => {
    const big = new ClipboardSync({
      read: () => local,
      write: (s) => writes.push(s),
      maxTextLength: 10
    })
    big.poll()
    local = { kind: 'text', text: 'x'.repeat(50) }
    expect(big.poll()).toBeNull()
  })

  it('tolerates an unreadable clipboard', () => {
    sync.poll()
    local = null
    expect(sync.poll()).toBeNull()
  })
})
