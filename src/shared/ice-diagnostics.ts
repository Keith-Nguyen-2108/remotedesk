/**
 * Turns a failed WebRTC connection's stats into one line a person can act on.
 *
 * "peer: failed" on its own says nothing about *which* side of the network is
 * the problem, and the two machines are usually in different places with
 * nobody able to look at both. The candidate picture answers most of it:
 *
 *   - remote has no candidates at all  -> signalling never delivered them
 *   - remote has only srflx (public)   -> the other side's LAN address is
 *                                         hidden: Local Network permission
 *   - both have host candidates, no pair succeeded -> something drops the
 *                                         UDP between them: a firewall
 *
 * Pure function over the plain stat objects so it can be unit tested.
 */

export interface CandidateStat {
  type: 'local-candidate' | 'remote-candidate' | 'candidate-pair' | string
  candidateType?: string
  state?: string
  nominated?: boolean
}

function countTypes(stats: CandidateStat[], kind: string): string {
  const counts = new Map<string, number>()
  for (const s of stats) {
    if (s.type !== kind) continue
    const t = s.candidateType ?? 'unknown'
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  if (counts.size === 0) return 'none'
  return [...counts.entries()].map(([t, n]) => `${t}×${n}`).join(' ')
}

export function summarizeIceFailure(stats: CandidateStat[]): string {
  const local = countTypes(stats, 'local-candidate')
  const remote = countTypes(stats, 'remote-candidate')
  const pairs = stats.filter((s) => s.type === 'candidate-pair')
  const succeeded = pairs.filter((p) => p.state === 'succeeded').length

  let hint: string
  if (remote === 'none') {
    hint = 'no candidates arrived from the other machine - signalling problem'
  } else if (!remote.includes('host')) {
    hint = "other machine's LAN address is hidden - check its Local Network permission"
  } else if (succeeded === 0) {
    hint = 'both sides visible but no path connected - a firewall is dropping UDP (check macOS Firewall on both)'
  } else {
    hint = 'a path connected then dropped - network changed or VPN interfered'
  }

  return `peer: failed - local ${local}; remote ${remote}; ${pairs.length} pairs, ${succeeded} ok. ${hint}`
}
