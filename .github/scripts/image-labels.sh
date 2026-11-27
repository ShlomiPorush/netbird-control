#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/../.."
CL=.github/scripts/changelog.js

if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  echo "image-labels.sh needs the full history and the release tags (fetch-depth: 0)" >&2
  exit 1
fi

VERSION=$(tr -d '[:space:]' < VERSION)
node "$CL" check-version "$VERSION"

markers_of() { sed 's/\r$//' | sed '/^[[:space:]]*$/d'; }
mapfile -t MARKERS < <(markers_of < ROLLOUT_BREAKS)
if [ "${#MARKERS[@]}" -eq 0 ]; then
  echo "ROLLOUT_BREAKS is empty" >&2
  exit 1
fi
if [ "$(printf '%s\n' "${MARKERS[@]}" | sort | uniq -d | head -1)" != "" ]; then
  echo "ROLLOUT_BREAKS has a marker twice" >&2
  exit 1
fi

mapfile -t TAGS < <(git tag --merged HEAD --list 'v[0-9]*' | sed 's/^v//' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1,1n -k2,2n -k3,3n)

for tag in "${TAGS[@]}"; do
  while IFS= read -r shipped; do
    if ! printf '%s\n' "${MARKERS[@]}" | grep -Fxq -- "$shipped"; then
      echo "ROLLOUT_BREAKS lost the marker \"$shipped\" that v$tag shipped; markers are never removed" >&2
      exit 1
    fi
  done < <(git show "v$tag:ROLLOUT_BREAKS" 2>/dev/null | markers_of)
done

ROLLOUT_FROM=""
for marker in "${MARKERS[@]}"; do
  first="$VERSION"
  for tag in "${TAGS[@]}"; do
    if git show "v$tag:ROLLOUT_BREAKS" 2>/dev/null | markers_of | grep -Fxq -- "$marker"; then
      first="$tag"
      break
    fi
  done
  if [ -z "$ROLLOUT_FROM" ] || node "$CL" gt "$first" "$ROLLOUT_FROM" 2>/dev/null; then
    ROLLOUT_FROM="$first"
  fi
done

COMPOSE_SHA256=$(git show HEAD:docker-compose.yml | sha256sum | cut -d ' ' -f 1)
echo "netbird-control.compose-sha256=$COMPOSE_SHA256"
echo "netbird-control.rollout-from=$ROLLOUT_FROM"
