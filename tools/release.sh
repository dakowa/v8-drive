#!/usr/bin/env bash
# Cut a release: bump the asset version, rebuild docs/prev/ from the previous release's tag,
# commit "Release vN" and tag it vN. Pushing stays manual (git push && git push --tags).
#
# Usage: tools/release.sh <N>        e.g. tools/release.sh 9
#
# Every release is a tag (v1, v2, ...), and the previous one stays playable on the phone at
# https://dakowa.github.io/v8-drive/prev/ so a failed feature is one tap away from undone.
# Rolling back for good: git revert the feature's commit (features are separate commits that
# never touch the ?v= strings), then cut a new release.
set -euo pipefail
cd "$(dirname "$0")/.."

N="${1:?usage: tools/release.sh <N>}"
OLD=$(grep -o "const VERSION = '[0-9]*'" docs/app.js | grep -o '[0-9]\+')
PREV=$(git tag -l 'v[0-9]*' --sort=-v:refname | head -1)
[ "$N" -gt "$OLD" ] || { echo "v$N is not newer than the current v$OLD"; exit 1; }
[ -z "$(git status --porcelain docs)" ] || { echo "commit the feature changes in docs/ first"; exit 1; }
git rev-parse -q --verify "refs/tags/v$N" >/dev/null && { echo "tag v$N exists"; exit 1; }
grep -q "^## v$N" CHANGELOG.md || { echo "add a '## v$N' entry to CHANGELOG.md first"; exit 1; }

# asset version: app.js VERSION, every ?v= in docs (index.html, imports, dev tools)
sed -i "s/const VERSION = '$OLD'/const VERSION = '$N'/" docs/app.js
grep -rl "?v=$OLD" docs --include='*.js' --include='*.html' --exclude-dir=prev | xargs sed -i "s/?v=$OLD\b/?v=$N/g"

# previous release, without the dev tools
rm -rf docs/prev
mkdir -p docs/prev
git archive "$PREV" docs | tar -x -C docs/prev --strip-components=1 --exclude='docs/dev' --exclude='docs/prev'
# releases before v9 don't know they can be the previous one: add a way back
if ! grep -q 'id="verLink"' docs/prev/index.html; then
  sed -i "0,/<body>/s||<body><a href=\"../\" style=\"display:block;padding:10px 16px;background:#3a2a10;color:#ffcf80;font:600 14px system-ui;text-align:center;text-decoration:none\">You're on ${PREV} (previous release) · back to v$N</a>|" docs/prev/index.html
fi
printf '{"current": %s, "prev": "%s"}\n' "$N" "${PREV#v}" > docs/versions.json

git add -A docs CHANGELOG.md
git commit -q -m "Release v$N

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git tag -a "v$N" -m "v$N"
echo "released v$N (previous: $PREV at docs/prev/). Push with: git push && git push --tags"
