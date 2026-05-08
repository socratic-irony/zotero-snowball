#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src"
BUILD="$ROOT/build"
VERSION="$(python3 -c 'import json, pathlib, sys; print(json.load(open(pathlib.Path(sys.argv[1]) / "src/manifest.json"))["version"])' "$ROOT")"
XPI="$BUILD/snowball-sources-$VERSION.xpi"

rm -rf "$BUILD"
mkdir -p "$BUILD"

python3 -m json.tool "$SRC/manifest.json" > /dev/null

cd "$SRC"

zip -r "$XPI" \
  manifest.json \
  bootstrap.js \
  prefs.js \
  chrome \
  locale \
  icons \
  -x "*.DS_Store" \
  -x "__MACOSX/*"

cd "$ROOT"

echo "Built $XPI"
echo
echo "Archive contents:"
unzip -l "$XPI" | sed -n '1,80p'

echo
echo "Checking root files..."
contents="$(unzip -Z1 "$XPI")"
grep -Fxq "manifest.json" <<< "$contents"
grep -Fxq "bootstrap.js" <<< "$contents"

echo "OK: manifest.json and bootstrap.js are at archive root."
