#!/bin/bash
# Prepare a release pull request:  ./scripts/release.sh X.Y.Z
#
# Creates the branch release/vX.Y.Z from an up-to-date main, sets VERSION, turns the
# "## [Unreleased]" section of CHANGELOG.md into "## [X.Y.Z] - <today>", pushes the branch and
# opens a pull request. Nothing is published here: merging that pull request runs
# .github/workflows/release.yml, which tags the merge commit, builds the image and creates the
# GitHub release. This script never creates, moves or force-pushes a tag.
set -euo pipefail

# Run from the repo root regardless of where the script is invoked from
cd "$(dirname "$0")/.."

die() { echo "❌ $*" >&2; exit 1; }

[ $# -eq 1 ] || die "Usage: $0 X.Y.Z"
VERSION=$1
TAG="v$VERSION"
BRANCH="release/$TAG"
CL=".github/scripts/changelog.js"

command -v node >/dev/null || die "node is required"
command -v gh >/dev/null || die "gh (GitHub CLI) is required"
node "$CL" check-version "$VERSION" || die "Use a stable X.Y.Z version"

echo "🔍 Checking that $TAG can be released..."
[ "$(git branch --show-current)" = "main" ] || die "Switch to main first"
[ -z "$(git status --porcelain)" ] || die "The working tree has uncommitted or untracked changes"
git fetch origin || die "git fetch failed"
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main differs from origin/main - pull (or push) first"

CURRENT=$(tr -d '[:space:]' < VERSION)
node "$CL" gt "$VERSION" "$CURRENT" || die "$VERSION must be greater than the current version $CURRENT"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then die "Tag $TAG already exists locally"; fi
REMOTE_TAG=$(git ls-remote --tags origin "refs/tags/$TAG") || die "Could not read the tags on origin"
[ -z "$REMOTE_TAG" ] || die "Tag $TAG already exists on origin"

if git rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null; then die "Branch $BRANCH already exists locally"; fi
REMOTE_BRANCH=$(git ls-remote --heads origin "refs/heads/$BRANCH") || die "Could not read the branches on origin"
[ -z "$REMOTE_BRANCH" ] || die "Branch $BRANCH already exists on origin"

node "$CL" section Unreleased >/dev/null || die "Add the release notes under \"## [Unreleased]\" in CHANGELOG.md first"

# Ensure git user.email is configured for this repository (only once every check has passed)
REQUIRED_EMAIL="5992161+ShlomiPorush@users.noreply.github.com"
CURRENT_EMAIL=$(git config user.email 2>/dev/null || true)
if [ "$CURRENT_EMAIL" != "$REQUIRED_EMAIL" ]; then
    echo "🔧 Configuring git user.email..."
    git config user.email "$REQUIRED_EMAIL"
fi

echo "📦 Preparing $TAG on $BRANCH..."
git switch -c "$BRANCH"
printf '%s' "$VERSION" > VERSION
# Legacy fallback the backend reads when VERSION is missing
printf '%s' "$VERSION" > backend/version.txt
node "$CL" cut "$VERSION" "$(date +%Y-%m-%d)"
git add VERSION backend/version.txt CHANGELOG.md
git commit -m "Release version $VERSION"

echo "⬆️  Pushing $BRANCH..."
git push -u origin "$BRANCH"

echo "📝 Opening the release pull request..."
if ! gh pr create --base main --head "$BRANCH" --title "Release $TAG" --body "$(node "$CL" section "$VERSION")"; then
    echo "❌ The branch is pushed, but the pull request was not created. Open it with:" >&2
    echo "   gh pr create --base main --head $BRANCH --title \"Release $TAG\" --body \"\$(node $CL section $VERSION)\"" >&2
    exit 1
fi

echo "✅ Release pull request for $TAG is open. Merging it publishes the release."
