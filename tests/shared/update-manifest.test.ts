import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  parseManifest,
  platformKey,
  selectUpdate
} from '../../src/shared/update-manifest'

const goodFile = {
  url: 'https://github.com/o/r/releases/latest/download/RemoteDesk-arm64.zip',
  sha256: 'a'.repeat(64),
  size: 1234
}

describe('compareVersions', () => {
  it('orders by numeric segment, not lexically', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1)
    expect(compareVersions('0.1.9', '0.1.10')).toBe(-1)
    expect(compareVersions('0.1.2', '0.1.2')).toBe(0)
  })

  it('treats a missing segment as zero', () => {
    expect(compareVersions('0.2', '0.2.0')).toBe(0)
    expect(compareVersions('0.2.1', '0.2')).toBe(1)
  })
})

describe('parseManifest', () => {
  it('accepts a well-formed manifest', () => {
    const m = parseManifest({ version: '0.1.42', files: { 'darwin-arm64': goodFile } })
    expect(m?.version).toBe('0.1.42')
    expect(m?.files['darwin-arm64']?.sha256).toBe('a'.repeat(64))
  })

  it('rejects junk instead of throwing', () => {
    expect(parseManifest(null)).toBeNull()
    expect(parseManifest('nope')).toBeNull()
    expect(parseManifest({ files: { 'darwin-arm64': goodFile } })).toBeNull()
    expect(parseManifest({ version: 'latest', files: { 'darwin-arm64': goodFile } })).toBeNull()
    expect(parseManifest({ version: '0.1.1', files: {} })).toBeNull()
  })

  it('drops entries that could point the downloader somewhere unverifiable', () => {
    const m = parseManifest({
      version: '0.1.42',
      files: {
        insecure: { ...goodFile, url: 'http://example.com/x.zip' },
        unhashed: { ...goodFile, sha256: 'nope' },
        sizeless: { ...goodFile, size: 0 },
        'darwin-arm64': goodFile
      }
    })
    expect(Object.keys(m?.files ?? {})).toEqual(['darwin-arm64'])
  })
})

describe('selectUpdate', () => {
  const manifest = { version: '0.1.42', files: { 'darwin-arm64': goodFile } }

  it('offers a newer build for this platform', () => {
    expect(selectUpdate(manifest, '0.1.41', 'darwin-arm64')?.version).toBe('0.1.42')
  })

  it('stays quiet when already current or newer', () => {
    expect(selectUpdate(manifest, '0.1.42', 'darwin-arm64')).toBeNull()
    expect(selectUpdate(manifest, '0.2.0', 'darwin-arm64')).toBeNull()
  })

  it('stays quiet when the release has no build for this machine', () => {
    expect(selectUpdate(manifest, '0.1.41', 'win32-x64')).toBeNull()
  })
})

describe('platformKey', () => {
  it('joins platform and arch', () => {
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64')
  })
})
