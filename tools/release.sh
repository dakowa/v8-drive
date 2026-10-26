#!/usr/bin/env bash
# Cut a release: bump the asset version, archive every earlier release at docs/v/<N>/ (from its
# tag), list them all at docs/v/, commit "Release vN" and tag it vN. Pushing stays manual.
# (git push && git push --tags)
#
# Usage: tools/release.sh <N>        e.g. tools/release.sh 9
#
# Every release is a tag (v1, v2, ...), and every earlier one stays playable on the phone at
# https://dakowa.github.io/v8-drive/v/<N>/ (list at .../v/, the header badge opens it), so a
# failed feature is one tap away from undone.
# Rolling back for good: git revert the feature's commit (features are separate commits that
# never touch the ?v= strings), then cut a new release.
set -euo pipefail
cd "$(dirname "$0")/.."

N="${1:?usage: tools/release.sh <N>}"
OLD=$(grep -o "const VERSION = '[0-9]*'" docs/app.js | grep -o '[0-9]\+')
[ "$N" -gt "$OLD" ] || { echo "v$N is not newer than the current v$OLD"; exit 1; }
[ -z "$(git status --porcelain docs)" ] || { echo "commit the feature changes in docs/ first"; exit 1; }
git rev-parse -q --verify "refs/tags/v$N" >/dev/null && { echo "tag v$N exists"; exit 1; }
grep -q "^## v$N" CHANGELOG.md || { echo "add a '## v$N' entry to CHANGELOG.md first"; exit 1; }

# asset version: app.js VERSION, every ?v= in docs (index.html, imports, dev tools)
sed -i "s/const VERSION = '$OLD'/const VERSION = '$N'/" docs/app.js
grep -rl "?v=$OLD" docs --include='*.js' --include='*.html' --exclude-dir=v | xargs sed -i "s/?v=$OLD\b/?v=$N/g"

# earlier releases, each with its own storage, and the list of all of them
python3 tools/build_versions.py "$N"

git add -A docs CHANGELOG.md
git commit -q -m "Release v$N

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git tag -a "v$N" -m "v$N"
echo "released v$N (earlier releases at docs/v/). Push with: git push && git push --tags"
