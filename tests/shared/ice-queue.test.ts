import { describe, expect, it, vi } from 'vitest'
import { IceQueue } from '../../src/shared/ice-queue'
import type { IceCandidatePayload } from '../../src/shared/protocol'

function candidate(n: number): IceCandidatePayload {
  return { candidate: `candidate:${n} 1 udp`, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null }
}

function fakeTarget() {
  const added: string[] = []
  return {
    added,
    addIceCandidate: async (init: { candidate?: string }) => {
      added.push(init.candidate ?? '')
    }
  }
}

describe('IceQueue', () => {
  it('holds candidates that arrive before the connection is ready', async () => {
    // The real race: ICE starts flowing the moment the offerer calls
    // setLocalDescription, which is before the offer itself reaches the peer.
    const queue = new IceQueue()
    await queue.add(candidate(1))
    await queue.add(candidate(2))

    const target = fakeTarget()
    expect(target.added).toEqual([])

    await queue.open(target)
    expect(target.added).toEqual(['candidate:1 1 udp', 'candidate:2 1 udp'])
  })

  it('passes candidates straight through once open', async () => {
    const queue = new IceQueue()
    const target = fakeTarget()
    await queue.open(target)

    await queue.add(candidate(7))
    expect(target.added).toEqual(['candidate:7 1 udp'])
  })

  it('preserves arrival order across the queued/live boundary', async () => {
    const queue = new IceQueue()
    await queue.add(candidate(1))

    const target = fakeTarget()
    await queue.open(target)
    await queue.add(candidate(2))

    expect(target.added).toEqual(['candidate:1 1 udp', 'candidate:2 1 udp'])
  })

  it('survives a candidate the connection refuses, and keeps going', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const added: string[] = []
    const target = {
      addIceCandidate: async (init: { candidate?: string }) => {
        if (init.candidate?.includes('bad')) throw new Error('invalid candidate')
        added.push(init.candidate ?? '')
      }
    }

    const queue = new IceQueue()
    await queue.open(target)
    await queue.add({ candidate: 'bad', sdpMid: null, sdpMLineIndex: null, usernameFragment: null })
    await queue.add(candidate(3))

    expect(added).toEqual(['candidate:3 1 udp'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('drops what it was holding when reset', async () => {
    const queue = new IceQueue()
    await queue.add(candidate(1))
    queue.reset()

    const target = fakeTarget()
    await queue.open(target)
    expect(target.added).toEqual([])
  })

  it('maps null sdp fields to undefined, as addIceCandidate expects', async () => {
    const seen: Array<Record<string, unknown>> = []
    const target = {
      addIceCandidate: async (init: Record<string, unknown>) => {
        seen.push(init)
      }
    }
    const queue = new IceQueue()
    await queue.open(target)
    await queue.add({
      candidate: 'candidate:9 1 udp',
      sdpMid: null,
      sdpMLineIndex: null,
      usernameFragment: null
    })

    expect(seen[0]).toEqual({
      candidate: 'candidate:9 1 udp',
      sdpMid: undefined,
      sdpMLineIndex: undefined,
      usernameFragment: undefined
    })
  })
})
