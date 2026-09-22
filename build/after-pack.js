const { execFileSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

/**
 * The certificate every macOS build must be signed with. This is the SHA-1 of
 * the project's self-signed "RemoteDesk Self-Signed" certificate, and it is
 * load-bearing: macOS remembers Screen Recording and Accessibility grants
 * against the designated requirement
 *
 *   identifier "com.keithnguyen.remotedesk" and certificate root = H"<this>"
 *
 * so as long as every build carries this exact certificate, a grant made once
 * survives every self-update. A build signed with anything else - or left
 * unsigned - is a different app to macOS: unsigned bundles are refused Screen
 * Recording outright even with the toggle on (an invalid signature fails
 * TCC's validation), and a different certificate forces every machine to
 * grant again from scratch.
 */
const EXPECTED_IDENTITY = '18F396F8722714368765534C9E5862362E8791B0'
const LOCAL_SIGNING_DIR = join(homedir(), '.remotedesk-signing')
const LOCAL_KEYCHAIN = 'remotedesk-signing.keychain-db'

function resolveSigning() {
  const identity = process.env.MACOS_SIGN_IDENTITY ?? EXPECTED_IDENTITY
  let keychain = process.env.MACOS_SIGN_KEYCHAIN ?? null

  // Local builds: the certificate lives in a dedicated keychain that auto-locks,
  // and its password sits next to the certificate. Unlock it so `npm run
  // dist:mac` just works, the same way it does on CI.
  if (!keychain && existsSync(join(LOCAL_SIGNING_DIR, 'kc.pass'))) {
    keychain = join(homedir(), 'Library/Keychains', LOCAL_KEYCHAIN)
    const password = readFileSync(join(LOCAL_SIGNING_DIR, 'kc.pass'), 'utf8').trim()
    execFileSync('security', ['unlock-keychain', '-p', password, keychain], { stdio: 'inherit' })
  }
  return { identity, keychain }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const { identity, keychain } = resolveSigning()

  if (identity.toUpperCase() !== EXPECTED_IDENTITY) {
    // Refuse rather than ship: a build under a different certificate would
    // install fine and then silently make every machine re-grant permissions.
    throw new Error(
      `afterPack: refusing to sign with ${identity} - RemoteDesk must be signed with ${EXPECTED_IDENTITY} ` +
        'or installed copies lose their Screen Recording / Accessibility grants on update'
    )
  }

  const args = ['--force', '--deep', '--sign', identity]
  if (keychain) args.push('--keychain', keychain)
  args.push(appPath)
  console.log(`  • signing ${appPath} with RemoteDesk Self-Signed (${identity.slice(0, 8)}…)`)
  execFileSync('codesign', args, { stdio: 'inherit' })

  // Prove it, in the build, every time: a valid seal and the exact designated
  // requirement macOS will key the permission grants on.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  const requirement = execFileSync('codesign', ['-d', '-r-', appPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (!requirement.toLowerCase().includes(`certificate root = h"${EXPECTED_IDENTITY.toLowerCase()}"`)) {
    throw new Error(`afterPack: unexpected designated requirement after signing:\n${requirement}`)
  }
  console.log('  • signature valid; designated requirement pinned to the RemoteDesk certificate')
}
