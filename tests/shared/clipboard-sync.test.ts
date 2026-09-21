import { beforeEach, describe, expect, it } from 'vitest'
import { ClipboardSync, type ClipSnapshot } from '../../src/shared/clipboard-sync'

let local: ClipSnapshot | null
let writes: ClipSnapshot[]
let sync: ClipboardSync

beforeEach(() => {
  local = { kind: 'text', text: 'initial' }
  writes = []
  sync = new ClipboardSync({
    read: async () => local,
    write: async (snapshot) => {
      writes.push(snapshot)
      local = snapshot
    }
  })
})

describe('ClipboardSync', () => {
  it('does not push whatever was already on the clipboard at startup', async () => {
    expect(await sync.poll()).toBeNull()
  })

  it('pushes the clipboard after a local copy', async () => {
    await sync.poll()
    local = { kind: 'text', text: 'copied by me' }
    expect(await sync.poll()).toEqual({ kind: 'text', text: 'copied by me' })
  })

  it('reports nothing while the clipboard is unchanged', async () => {
    await sync.poll()
    local = { kind: 'text', text: 'copied by me' }
    expect(await sync.poll()).not.toBeNull()
    expect(await sync.poll()).toBeNull()
    expect(await sync.poll()).toBeNull()
  })

  it('writes a remote snapshot locally', async () => {
    await sync.poll()
    await sync.applyRemote({ kind: 'text', text: 'from peer' })
    expect(writes).toEqual([{ kind: 'text', text: 'from peer' }])
  })

  it('never echoes a remote snapshot back to the peer', async () => {
    await sync.poll()
    await sync.applyRemote({ kind: 'text', text: 'from peer' })
    expect(await sync.poll()).toBeNull()
  })

  it('pushes again after a local copy that follows a remote write', async () => {
    await sync.poll()
    await sync.applyRemote({ kind: 'text', text: 'from peer' })
    local = { kind: 'text', text: 'mine again' }
    expect(await sync.poll()).toEqual({ kind: 'text', text: 'mine again' })
  })

  it('handles images by data url', async () => {
    await sync.poll()
    local = { kind: 'image', dataUrl: 'data:image/png;base64,AAAA' }
    expect(await sync.poll()).toEqual({ kind: 'image', dataUrl: 'data:image/png;base64,AAAA' })
    expect(await sync.poll()).toBeNull()
  })

  it('skips text larger than the limit instead of flooding the channel', async () => {
    const big = new ClipboardSync({
      read: async () => local,
      write: async (s) => {
        writes.push(s)
      },
      maxTextLength: 10
    })
    await big.poll()
    local = { kind: 'text', text: 'x'.repeat(50) }
    expect(await big.poll()).toBeNull()
  })

  it('tolerates an unreadable clipboard', async () => {
    await sync.poll()
    local = null
    expect(await sync.poll()).toBeNull()
  })

  it('tolerates a read that rejects, instead of crashing the poll loop', async () => {
    const flaky = new ClipboardSync({
      read: async () => {
        throw new Error('OS clipboard busy')
      },
      write: async () => undefined
    })
    await expect(flaky.poll()).resolves.toBeNull()
  })
})
