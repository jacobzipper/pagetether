#!/usr/bin/env bash
# Build the site and publish it as a commit on the gh-pages branch, which
# GitHub Pages serves. No CI involved: run it from a clean checkout of main.
#
#   scripts/publish-site.sh [remote]     default remote: origin
set -euo pipefail

remote="${1:-origin}"
root="$(git rev-parse --show-toplevel)"
out="$(mktemp -d)"
index="$(mktemp -u)"
trap 'rm -rf "$out" "$index"' EXIT

node "$root/scripts/build-site.js" "$out"

source_commit="$(git -C "$root" rev-parse --short HEAD)"
git -C "$root" fetch --quiet "$remote" gh-pages 2>/dev/null || true
parent="$(git -C "$root" rev-parse --verify --quiet "refs/remotes/$remote/gh-pages" || true)"

# Stage the build output into a throwaway index, so the working tree and the
# real index are left alone.
export GIT_INDEX_FILE="$index"
git -C "$root" --work-tree="$out" add -A
tree="$(git -C "$root" write-tree)"
unset GIT_INDEX_FILE

if [ -n "$parent" ] && [ "$(git -C "$root" rev-parse "$parent^{tree}")" = "$tree" ]; then
  echo "site is already up to date on $remote/gh-pages"
  exit 0
fi

commit="$(git -C "$root" commit-tree "$tree" ${parent:+-p "$parent"} -m "Publish site from $source_commit")"
git -C "$root" push "$remote" "$commit:refs/heads/gh-pages"
echo "published $commit to $remote/gh-pages"
