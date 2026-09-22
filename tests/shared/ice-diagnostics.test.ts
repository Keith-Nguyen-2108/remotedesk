import { describe, expect, it } from 'vitest'
import { summarizeIceFailure } from '../../src/shared/ice-diagnostics'

const host = (type: 'local-candidate' | 'remote-candidate') => ({ type, candidateType: 'host' })
const srflx = (type: 'local-candidate' | 'remote-candidate') => ({ type, candidateType: 'srflx' })
const pair = (state: string) => ({ type: 'candidate-pair', state })

describe('summarizeIceFailure', () => {
  it('blames signalling when nothing arrived from the peer', () => {
    const s = summarizeIceFailure([host('local-candidate'), srflx('local-candidate')])
    expect(s).toContain('remote none')
    expect(s).toMatch(/signalling/)
  })

  it('points at Local Network permission when the peer only shows a public address', () => {
    const s = summarizeIceFailure([host('local-candidate'), srflx('remote-candidate'), pair('failed')])
    expect(s).toMatch(/Local Network/)
  })

  it('points at a firewall when both sides are visible but nothing connected', () => {
    const s = summarizeIceFailure([
      host('local-candidate'), srflx('local-candidate'),
      host('remote-candidate'), srflx('remote-candidate'),
      pair('failed'), pair('failed')
    ])
    expect(s).toContain('local host×1 srflx×1')
    expect(s).toContain('remote host×1 srflx×1')
    expect(s).toContain('2 pairs, 0 ok')
    expect(s).toMatch(/firewall/i)
  })

  it('reports a dropped path when a pair had succeeded', () => {
    const s = summarizeIceFailure([host('local-candidate'), host('remote-candidate'), pair('succeeded')])
    expect(s).toMatch(/connected then dropped/)
  })
})
