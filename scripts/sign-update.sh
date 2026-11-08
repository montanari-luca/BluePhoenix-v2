#!/usr/bin/env bash
# Sign a BluePhoenix installer for the in-app updater and print its bluephoenix-d.json entry.
#
# Usage: scripts/sign-update.sh [-k secret.key] <installer> <macos|windows|linux> <https-download-url>
#   -k FILE   minisign secret key (default: $BLUEPHOENIX_SIGNING_KEY or ~/.minisign/bluephoenix.key)
#
# Writes <installer>.minisig, checks it against src-tauri/keys/update.pub (the key built into the
# app), then prints the JSON to paste into bluephoenix-d.json in the MintFlow-Releases repository.
# Requires minisign (brew install minisign, or https://jedisct1.github.io/minisign/).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

KEY="${BLUEPHOENIX_SIGNING_KEY:-$HOME/.minisign/bluephoenix.key}"
PUB="${BLUEPHOENIX_UPDATE_PUB:-$ROOT/src-tauri/keys/update.pub}"

fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
usage() { sed -n '2,9p' "$0"; exit "${1:-0}"; }

while getopts ":k:h" opt; do
  case "$opt" in
    k) KEY="$OPTARG" ;;
    h) usage 0 ;;
    *) usage 2 ;;
  esac
done
shift $((OPTIND - 1))
[ $# -eq 3 ] || usage 2
FILE="$1"; PLATFORM="$2"; URL="$3"

case "$PLATFORM" in macos|windows|linux) ;; *) fail "Platform must be macos, windows or linux." ;; esac
case "$URL" in https://*) ;; *) fail "The download URL must start with https:// (the app refuses anything else)." ;; esac
case "$URL" in *'"'*|*'\'*|*' '*) fail "The download URL must not contain quotes, backslashes or spaces." ;; esac
command -v minisign >/dev/null || fail "minisign is not installed (brew install minisign)."
[ -f "$FILE" ] || fail "Installer not found: $FILE"
[ -f "$KEY" ] || fail "Secret key not found: $KEY (set BLUEPHOENIX_SIGNING_KEY or pass -k)."
grep -q '^RW' "$PUB" || fail "$PUB has no public key yet. Generate the release key first (docs/updates.md)."

if command -v sha256sum >/dev/null; then
  SHA=$(sha256sum "$FILE" | cut -d' ' -f1)
else
  SHA=$(shasum -a 256 "$FILE" | cut -d' ' -f1)
fi

SIG="$FILE.minisig"
NAME=$(basename "$FILE")
minisign -S -s "$KEY" -m "$FILE" -x "$SIG" -t "$NAME sha256:$SHA" >&2
minisign -V -q -p "$PUB" -m "$FILE" -x "$SIG" >/dev/null \
  || fail "The signature doesn't verify against $PUB. Is $KEY the release key?"

# One line, so it fits in JSON without escaping.
SIG_B64=$(base64 < "$SIG" | tr -d '\n')

cat <<EOF

Signed $NAME
Paste this entry into bluephoenix-d.json:

  "$PLATFORM": {
    "url": "$URL",
    "sha256": "$SHA",
    "signature": "$SIG_B64"
  }

Or, so that app versions 0.2.2 and older can still see the update, the flat form:

  "$PLATFORM": "$URL",
  "${PLATFORM}_sha256": "$SHA",
  "${PLATFORM}_signature": "$SIG_B64"
EOF
