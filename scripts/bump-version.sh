#!/usr/bin/env bash
# Set the BluePhoenix version everywhere it lives.
#
# Usage: scripts/bump-version.sh <x.y.z> [--no-check]
#   Updates package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json,
#   ios/project.yml and the README badge, then runs `cargo check` so
#   Cargo.lock picks up the new version.
#   --no-check  skip `cargo check` (Cargo.lock is then left as it is)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=""; CHECK=1
for a in "$@"; do
  case "$a" in
    --no-check) CHECK=0 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    -*) echo "Unknown option: $a" >&2; exit 2 ;;
    *) VERSION="$a" ;;
  esac
done

step() { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -n "$VERSION" ] || fail "Give a version, for example: scripts/bump-version.sh 0.2.3"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail "\"$VERSION\" is not a semver version (x.y.z)."

# Portable in-place edit (BSD and GNU sed differ on -i).
replace() { # file, perl substitution
  [ -f "$1" ] || fail "Missing $1"
  perl -0pi -e "$2" "$1"
}

step "Setting version to $VERSION"
replace package.json              's/("version":\s*")[^"]+(")/${1}'"$VERSION"'${2}/'
replace src-tauri/tauri.conf.json 's/("version":\s*")[^"]+(")/${1}'"$VERSION"'${2}/'
replace src-tauri/Cargo.toml      's/^(version\s*=\s*")[^"]+(")/${1}'"$VERSION"'${2}/m'
# Apple only accepts numeric versions, so iOS gets x.y.z without any "-beta.1" suffix.
IOS_VERSION="${VERSION%%-*}"
replace ios/project.yml           's/(MARKETING_VERSION:\s*")[^"]+(")/${1}'"$IOS_VERSION"'${2}/; s/(CURRENT_PROJECT_VERSION:\s*")[^"]+(")/${1}'"$IOS_VERSION"'${2}/'
# shields.io escapes "-" as "--" inside badge text.
BADGE="${VERSION//-/--}"
replace README.md                 's/(badge\/version-)[^-]+(?:--[^-]+)*(-[0-9a-fA-F]{6})/${1}'"$BADGE"'${2}/'

for f in package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml ios/project.yml README.md; do
  grep -qF -e "$VERSION" -e "$BADGE" -e "\"$IOS_VERSION\"" "$f" || fail "Could not set the version in $f"
  echo "  ✓ $f"
done

if [ "$CHECK" = 1 ]; then
  step "Refreshing Cargo.lock"
  (cd src-tauri && cargo check --quiet)
fi

printf '\n\033[1;32m✓ Version is now %s.\033[0m Next: build, upload the installers, then update bluephoenix-v.json and bluephoenix-d.json in MintFlow-Releases.\n' "$VERSION"
