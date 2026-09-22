/**
 * Shape of the update.json the release pipeline publishes next to the
 * installers, and the pure logic for deciding whether it describes something
 * newer than what is running.
 *
 * Kept free of node and electron imports so it can be unit tested directly.
 */

export interface UpdateFile {
  url: string
  sha256: string
  size: number
}

export interface UpdateManifest {
  version: string
  /** Keyed by `${process.platform}-${process.arch}`. */
  files: Record<string, UpdateFile>
}

/** A build slot key, e.g. 'darwin-arm64'. */
export function platformKey(platform: string, arch: string): string {
  return `${platform}-${arch}`
}

function parts(version: string): number[] {
  return version
    .split('.')
    .map((p) => Number.parseInt(p, 10))
    .map((n) => (Number.isFinite(n) ? n : 0))
}

/** -1, 0 or 1, comparing dotted numeric versions segment by segment. */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a)
  const pb = parts(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va !== vb) return va < vb ? -1 : 1
  }
  return 0
}

/**
 * Validates a manifest fetched over the network. Anything unexpected returns
 * null rather than throwing: a malformed manifest must degrade to "no update
 * available", never break app startup.
 */
export function parseManifest(raw: unknown): UpdateManifest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.version !== 'string' || !/^\d+(\.\d+)*$/.test(obj.version)) return null
  if (typeof obj.files !== 'object' || obj.files === null) return null

  const files: Record<string, UpdateFile> = {}
  for (const [key, value] of Object.entries(obj.files as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const f = value as Record<string, unknown>
    // Only https, and only from the release host: this URL is handed to a
    // downloader whose result gets executed, so it must not be redirectable
    // to anywhere the manifest author pleases.
    if (typeof f.url !== 'string' || !f.url.startsWith('https://')) continue
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) continue
    if (typeof f.size !== 'number' || !Number.isFinite(f.size) || f.size <= 0) continue
    files[key] = { url: f.url, sha256: f.sha256, size: f.size }
  }
  if (Object.keys(files).length === 0) return null
  return { version: obj.version, files }
}

export interface AvailableUpdate {
  version: string
  file: UpdateFile
}

/**
 * The update this machine should install, or null when there is nothing to do
 * - already current, or this platform/arch has no build in the release.
 */
export function selectUpdate(
  manifest: UpdateManifest,
  currentVersion: string,
  key: string
): AvailableUpdate | null {
  if (compareVersions(manifest.version, currentVersion) <= 0) return null
  const file = manifest.files[key]
  if (!file) return null
  return { version: manifest.version, file }
}
