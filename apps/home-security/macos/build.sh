#!/bin/bash
# Builds "RIGS Camera.app" (apps/home-security/camera-helper.js): swiftc, Info.plist, the source hash, ad-hoc signature.
#   apps/home-security/macos/build.sh "$RIGS_HOME/bin/RIGS Camera.app" [bundle-id] [name]
# TCC keeps one camera entry per bundle id and pins an ad-hoc signature to the build's cdhash, so camera-helper.js runs
# this only when the source hash (or bundle id) changed: a rebuild needs a new Allow. A scratch RIGS_HOME builds under
# its own id (dev.rigs.camera.<hash8>) so it never disturbs the real helper's grant.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="${1:?usage: build.sh <path/RIGS Camera.app> [bundle-id] [name]}"
id="${2:-dev.rigs.camera}"
name="${3:-RIGS Camera}"
command -v swiftc >/dev/null || { echo "swiftc not found: run xcode-select --install" >&2; exit 2; }

# Same bytes, same order as sourceHash() in camera-helper.js; the stamp also names the bundle id.
hash="$(cat "$here/RigsCamera.swift" "$here/Info.plist" "$here/build.sh" | shasum -a 256 | cut -d' ' -f1) $id"
tmp="$app.build.$$"
trap 'rm -rf "$tmp"' EXIT
rm -rf "$tmp"
mkdir -p "$tmp/Contents/MacOS" "$tmp/Contents/Resources"
swiftc -O "$here/RigsCamera.swift" -o "$tmp/Contents/MacOS/rigs-camera" -framework AppKit -framework AVFoundation
cp "$here/Info.plist" "$tmp/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string "$id" "$tmp/Contents/Info.plist"
plutil -replace CFBundleName -string "$name" "$tmp/Contents/Info.plist"
plutil -replace CFBundleDisplayName -string "$name" "$tmp/Contents/Info.plist"
printf '%s\n' "$hash" > "$tmp/Contents/Resources/source.sha256"
codesign --force --sign - --identifier "$id" "$tmp"
codesign --verify --strict "$tmp"
rm -rf "$app"
mkdir -p "$(dirname "$app")"
mv "$tmp" "$app"
echo "$hash"
