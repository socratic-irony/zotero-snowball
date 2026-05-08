#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" ]; then
  XPI="$1"
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  VERSION="$(python3 -c 'import json, pathlib, sys; print(json.load(open(pathlib.Path(sys.argv[1]) / "src/manifest.json"))["version"])' "$ROOT")"
  XPI="build/snowball-sources-$VERSION.xpi"
fi

test -f "$XPI"

echo "Validating $XPI"

unzip -t "$XPI" > /dev/null

contents="$(unzip -Z1 "$XPI")"

if ! grep -Fxq "manifest.json" <<< "$contents"; then
  echo "ERROR: manifest.json is missing from archive root"
  exit 1
fi

if ! grep -Fxq "bootstrap.js" <<< "$contents"; then
  echo "ERROR: bootstrap.js is missing from archive root"
  exit 1
fi

if grep -Eq "^[^/]+/manifest\.json$" <<< "$contents"; then
  echo "ERROR: manifest.json appears inside a nested folder"
  exit 1
fi

echo "XPI structure looks valid."
