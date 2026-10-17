#!/bin/bash
# Builds "RIGS Control.app" (docs/full-access.md §4): swiftc, Info.plist, the source hash, ad-hoc signature.
#   scripts/control/macos/build.sh "$RIGS_HOME/bin/RIGS Control.app"
# The daemon runs this through src/control-mac-helper.js only when the source hash changed: an ad-hoc
# signature pins the Screen Recording/Accessibility grants to this build's cdhash, so a rebuild needs a re-grant.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="${1:?usage: build.sh <path/RIGS Control.app>}"
command -v swiftc >/dev/null || { echo "swiftc not found: run xcode-select --install" >&2; exit 2; }

# Same bytes, same order as sourceHash() in src/control-mac-helper.js.
hash="$(cat "$here/RigsControl.swift" "$here/Info.plist" "$here/build.sh" | shasum -a 256 | cut -d' ' -f1)"
tmp="$app.build.$$"
trap 'rm -rf "$tmp"' EXIT
rm -rf "$tmp"
mkdir -p "$tmp/Contents/MacOS" "$tmp/Contents/Resources"
swiftc -O -swift-version 5 "$here/RigsControl.swift" -o "$tmp/Contents/MacOS/rigs-control" \
  -framework AppKit -framework ApplicationServices -framework Carbon -framework CoreGraphics -framework ImageIO
cp "$here/Info.plist" "$tmp/Contents/Info.plist"
printf '%s\n' "$hash" > "$tmp/Contents/Resources/source.sha256"
codesign --force --sign - --identifier dev.rigs.control "$tmp"
codesign --verify --strict "$tmp"
rm -rf "$app"
mkdir -p "$(dirname "$app")"
mv "$tmp" "$app"
echo "$hash"
