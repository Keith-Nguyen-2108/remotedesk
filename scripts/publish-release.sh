#!/usr/bin/env bash
# Publishes the built installers to a stable "latest" GitHub Release, so
# testers always download from the same three URLs instead of receiving a
# new file over chat every time.
#
# Usage:
#   GH_TOKEN=github_pat_xxx ./scripts/publish-release.sh
#
# Requires dist/RemoteDesk-*.dmg and "dist/RemoteDesk Setup*.exe" to already
# be built (run npm run dist:mac / dist:win first).
#
# Stable download URLs (never change, always point at the newest upload):
#   https://github.com/Keith-Nguyen-2108/remotedesk/releases/latest/download/RemoteDesk-arm64.dmg
#   https://github.com/Keith-Nguyen-2108/remotedesk/releases/latest/download/RemoteDesk-intel.dmg
#   https://github.com/Keith-Nguyen-2108/remotedesk/releases/latest/download/RemoteDesk-Setup.exe

set -euo pipefail

REPO="Keith-Nguyen-2108/remotedesk"
TAG="latest"
DIST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dist"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [ -z "${GH_TOKEN:-}" ]; then
  echo "error: set GH_TOKEN to a fine-grained PAT with Contents: Read and write on $REPO" >&2
  exit 1
fi

API="https://api.github.com/repos/$REPO"
AUTH_HEADER="Authorization: Bearer $GH_TOKEN"
ACCEPT_HEADER="Accept: application/vnd.github+json"

ARM64_DMG=$(find "$DIST_DIR" -maxdepth 1 -type f -name "RemoteDesk-*-arm64.dmg" -print -quit)
INTEL_DMG=$(find "$DIST_DIR" -maxdepth 1 -type f -name "RemoteDesk-*.dmg" ! -name "*-arm64.dmg" -print -quit)
WIN_EXE=$(find "$DIST_DIR" -maxdepth 1 -type f -name "RemoteDesk Setup*.exe" -print -quit)

for pair in "arm64 dmg:$ARM64_DMG" "intel dmg:$INTEL_DMG" "windows exe:$WIN_EXE"; do
  label="${pair%%:*}"
  path="${pair#*:}"
  if [ -z "$path" ]; then
    echo "error: could not find the $label build in $DIST_DIR - build it first" >&2
    exit 1
  fi
  echo "$label: $path"
done

echo "--- deleting any existing '$TAG' release (so re-upload starts clean) ---"
existing_id=$(curl -s -H "$AUTH_HEADER" -H "$ACCEPT_HEADER" "$API/releases/tags/$TAG" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id') or '')")
if [ -n "$existing_id" ]; then
  curl -s -X DELETE -H "$AUTH_HEADER" -H "$ACCEPT_HEADER" "$API/releases/$existing_id" > /dev/null
  echo "deleted release id $existing_id"
fi
# Also remove the underlying git tag ref, or creating the release again with
# the same tag re-attaches to the old commit instead of moving forward.
curl -s -X DELETE -H "$AUTH_HEADER" -H "$ACCEPT_HEADER" "$API/git/refs/tags/$TAG" > /dev/null || true

echo "--- creating fresh '$TAG' release ---"
cat > "$TMP_DIR/release-body.json" <<JSON
{
  "tag_name": "$TAG",
  "name": "RemoteDesk (latest build)",
  "body": "Always-current build. These three files are overwritten on every publish - the download links never change.",
  "draft": false,
  "prerelease": false
}
JSON

curl -s -X POST -H "$AUTH_HEADER" -H "$ACCEPT_HEADER" "$API/releases" \
  --data-binary "@$TMP_DIR/release-body.json" > "$TMP_DIR/release-response.json"

cat > "$TMP_DIR/extract.py" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
if 'id' not in d:
    print('ERROR creating release:', json.dumps(d), file=sys.stderr)
    sys.exit(1)
print(d['id'])
print(d['upload_url'].split('{')[0])
PYEOF
result=$(python3 "$TMP_DIR/extract.py" "$TMP_DIR/release-response.json")
release_id=$(echo "$result" | sed -n '1p')
upload_url=$(echo "$result" | sed -n '2p')
echo "release id: $release_id"

upload() {
  local file="$1" name="$2" ctype="$3"
  echo "uploading $name ($(du -h "$file" | cut -f1)) ..."
  curl -s -X POST -H "$AUTH_HEADER" -H "Content-Type: $ctype" \
    --data-binary "@$file" \
    "$upload_url?name=$name" > "$TMP_DIR/upload-$name.json"
  python3 -c "
import json
with open('$TMP_DIR/upload-$name.json') as f:
    d = json.load(f)
print('  ->', d.get('browser_download_url', d))
"
}

upload "$ARM64_DMG" "RemoteDesk-arm64.dmg" "application/x-apple-diskimage"
upload "$INTEL_DMG" "RemoteDesk-intel.dmg" "application/x-apple-diskimage"
upload "$WIN_EXE" "RemoteDesk-Setup.exe" "application/octet-stream"

echo
echo "=== stable download URLs (never change) ==="
echo "  https://github.com/$REPO/releases/latest/download/RemoteDesk-arm64.dmg"
echo "  https://github.com/$REPO/releases/latest/download/RemoteDesk-intel.dmg"
echo "  https://github.com/$REPO/releases/latest/download/RemoteDesk-Setup.exe"
