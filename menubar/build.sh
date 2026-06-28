#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Builds OpenCodeBar.app from main.swift (native AppKit menu-bar utility).
# Produces ./OpenCodeBar.app, ad-hoc signed so it runs locally + can be a Login Item.
set -euo pipefail
cd "$(dirname "$0")"

APP="OpenCodeBar"
DEPLOY="13.0"          # SMAppService / SF Symbols need macOS 13+
mkdir -p build

echo "› swiftc compile (deployment target macOS $DEPLOY)"
swiftc -O \
  -target "arm64-apple-macos${DEPLOY}" \
  -framework AppKit -framework Security -framework ServiceManagement \
  main.swift -o "build/$APP"

echo "› assemble $APP.app bundle"
rm -rf "$APP.app"
mkdir -p "$APP.app/Contents/MacOS"
cp "build/$APP" "$APP.app/Contents/MacOS/$APP"
cp Info.plist "$APP.app/Contents/Info.plist"

echo "› ad-hoc codesign"
codesign --force --deep --sign - "$APP.app" >/dev/null 2>&1 || true

echo
echo "✓ Built: $(pwd)/$APP.app"
echo
echo "Install:   mv \"$APP.app\" /Applications/   (then double-click once)"
echo "Run now:   open \"$APP.app\""
echo "CLI check: \"$APP.app/Contents/MacOS/$APP\" --status"
