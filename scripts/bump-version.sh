#!/usr/bin/env bash
#
# Bump the Snowball Sources version in lockstep across:
#   - package.json
#   - src/manifest.json
#
# Usage:
#   ./scripts/bump-version.sh 0.2.1
#   ./scripts/bump-version.sh patch        # 0.2.0 -> 0.2.1
#   ./scripts/bump-version.sh minor        # 0.2.1 -> 0.3.0
#   ./scripts/bump-version.sh major        # 0.3.0 -> 1.0.0
#
# Refuses to run if either file is missing, if the current versions disagree,
# or if the requested target isn't a strictly higher semver than the current one.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PKG="package.json"
MAN="src/manifest.json"

if [ ! -f "$PKG" ] || [ ! -f "$MAN" ]; then
  echo "bump-version: missing $PKG or $MAN" >&2
  exit 1
fi

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "bump-version: node is required" >&2
    exit 1
  fi
}

require_node

current() {
  node -e "
    const pkg = require('$ROOT/$PKG').version;
    const man = require('$ROOT/$MAN').version;
    if (pkg !== man) {
      console.error('package.json (' + pkg + ') and manifest.json (' + man + ') versions disagree.');
      process.exit(2);
    }
    process.stdout.write(pkg);
  "
}

CURRENT="$(current)"

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <new-version|patch|minor|major>" >&2
  echo "Current version: $CURRENT" >&2
  exit 1
fi

ARG="$1"

bump_part() {
  local kind="$1"
  node -e "
    const [maj, min, pat] = '$CURRENT'.split('.').map(Number);
    let next;
    switch ('$kind') {
      case 'patch': next = [maj, min, pat + 1]; break;
      case 'minor': next = [maj, min + 1, 0]; break;
      case 'major': next = [maj + 1, 0, 0]; break;
      default: throw new Error('unknown kind');
    }
    process.stdout.write(next.join('.'));
  "
}

case "$ARG" in
  patch|minor|major) NEW="$(bump_part "$ARG")" ;;
  *) NEW="$ARG" ;;
esac

if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "bump-version: '$NEW' is not a valid semver (X.Y.Z)" >&2
  exit 1
fi

# Refuse to go backward (or stay the same).
if ! node -e "
  const cmp = (a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
  };
  process.exit(cmp('$NEW', '$CURRENT') > 0 ? 0 : 1);
"; then
  echo "bump-version: target $NEW is not higher than current $CURRENT" >&2
  exit 1
fi

echo "Bumping $CURRENT -> $NEW"

# Use Node to rewrite both files so we keep their existing formatting style.
node -e "
  const fs = require('fs');
  for (const path of ['$PKG', '$MAN']) {
    const raw = fs.readFileSync(path, 'utf8');
    const obj = JSON.parse(raw);
    obj.version = '$NEW';
    // Preserve trailing newline if present, and use 2-space indent (matches both files).
    const out = JSON.stringify(obj, null, 2) + (raw.endsWith('\n') ? '\n' : '');
    fs.writeFileSync(path, out);
    console.log('  updated', path);
  }
"

echo "Done. Suggested next steps:"
echo "  npm test && npm run build"
echo "  # update CHANGELOG.md"
echo "  git add -A && git commit -m 'Release $NEW' && git tag v$NEW && git push --follow-tags"
