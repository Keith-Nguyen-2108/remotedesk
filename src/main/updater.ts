import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, writeFileSync, createWriteStream, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app } from 'electron'
import {
  parseManifest,
  platformKey,
  selectUpdate,
  type AvailableUpdate,
  type UpdateFile
} from '../shared/update-manifest'

const REPO = 'Keith-Nguyen-2108/remotedesk'
const RELEASE_BASE = `https://github.com/${REPO}/releases/`
const MANIFEST_URL = `${RELEASE_BASE}latest/download/update.json`

/**
 * Self-update against the GitHub release the pipeline publishes on every push
 * to main.
 *
 * This is a hand-rolled updater rather than electron-updater because the app
 * is unsigned: macOS's built-in updater is Squirrel, which validates the new
 * bundle's code signature against the installed one and refuses outright
 * without a Developer ID certificate. Swapping the bundle ourselves needs no
 * certificate, so the integrity story has to be carried by the manifest
 * instead - every download is checked against a SHA-256 published alongside
 * it, over HTTPS, from a pinned release host.
 */

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'follow'
  })
  if (!res.ok) throw new Error(`update check failed: HTTP ${res.status}`)
  return res.json()
}

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const manifest = parseManifest(await fetchJson(MANIFEST_URL))
  if (!manifest) return null
  return selectUpdate(manifest, app.getVersion(), platformKey(process.platform, process.arch))
}

/**
 * Downloads to a private temp dir and returns the path, having confirmed the
 * bytes match the manifest. A mismatch throws and the file is not returned:
 * what comes back from here gets executed, so it is never good enough that the
 * download merely succeeded.
 */
export async function downloadUpdate(file: UpdateFile, name: string): Promise<string> {
  if (!file.url.startsWith(RELEASE_BASE)) {
    throw new Error('refusing an update from outside the release host')
  }

  const dir = mkdtempSync(join(tmpdir(), 'remotedesk-update-'))
  const target = join(dir, name)

  const res = await fetch(file.url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  if (!res.body) throw new Error('download failed: empty response')

  const hash = createHash('sha256')
  const out = createWriteStream(target)
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  body.on('data', (chunk: Buffer) => hash.update(chunk))
  await pipeline(body, out)

  const size = statSync(target).size
  if (size !== file.size) {
    throw new Error(`update is the wrong size (expected ${file.size}, got ${size})`)
  }
  const digest = hash.digest('hex')
  if (digest !== file.sha256) {
    throw new Error('update failed its checksum - refusing to install it')
  }
  return target
}

/** The .app bundle this process is running out of. */
function bundlePath(): string {
  // .../RemoteDesk.app/Contents/MacOS/RemoteDesk -> .../RemoteDesk.app
  return resolve(dirname(app.getPath('exe')), '..', '..')
}

/**
 * Replaces this install and relaunches.
 *
 * The swap has to outlive the process being replaced, so on both platforms it
 * is handed to a detached child that first waits for this PID to exit. Doing
 * it in-process would mean deleting the bundle out from under the running
 * executable, or on Windows holding a lock the installer needs.
 */
export function applyUpdate(downloadedPath: string): void {
  if (process.platform === 'darwin') {
    const bundle = bundlePath()
    const dir = dirname(downloadedPath)
    const script = join(dir, 'apply.sh')
    writeFileSync(
      script,
      [
        '#!/bin/bash',
        'set -e',
        `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done`,
        `cd "${dir}"`,
        'mkdir -p extracted',
        `/usr/bin/ditto -x -k "${downloadedPath}" extracted`,
        'new="$(find extracted -maxdepth 1 -name "*.app" -print -quit)"',
        // Bail out rather than delete the working install if the archive did
        // not contain what we expect.
        '[ -n "$new" ] || exit 1',
        `rm -rf "${bundle}"`,
        `cp -R "$new" "${bundle}"`,
        // Nothing here set com.apple.quarantine, but clear it defensively:
        // one quarantined file is enough for Gatekeeper to block the launch.
        `/usr/bin/xattr -cr "${bundle}" || true`,
        `open "${bundle}"`,
        `rm -rf "${dir}"`
      ].join('\n'),
      'utf8'
    )
    chmodSync(script, 0o755)
    spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref()
    app.quit()
    return
  }

  if (process.platform === 'win32') {
    // NSIS assisted installers still honour /S for an unattended reinstall.
    const args = [
      '/c',
      'start',
      '""',
      '/wait',
      downloadedPath,
      '/S',
      '&&',
      'start',
      '""',
      process.execPath
    ]
    spawn('cmd.exe', args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    app.quit()
    return
  }

  throw new Error(`no update path for ${process.platform}`)
}

export function artifactName(update: AvailableUpdate): string {
  const ext = process.platform === 'win32' ? 'exe' : 'zip'
  return `RemoteDesk-${update.version}-${process.arch}.${ext}`
}
