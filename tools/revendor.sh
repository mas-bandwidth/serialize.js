#!/bin/sh
# tools/revendor.sh <tag>: re-vendor the family's normative files from
# mas-bandwidth/serialize at a released tag, verbatim, then show the diff.
#
# STANDARD.md, conformance/ and conformance-controls/ are copies, never
# edited here; CI diffs all three against upstream. Run from the repository
# root, then review the diff and the runner changes it needs.
set -eu
tag=${1:?usage: tools/revendor.sh <tag>}
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$tag" https://github.com/mas-bandwidth/serialize.git "$scratch/serialize"
cp "$scratch/serialize/STANDARD.md" STANDARD.md
rm -rf conformance conformance-controls
cp -R "$scratch/serialize/conformance" conformance
cp -R "$scratch/serialize/conformance-controls" conformance-controls
echo "re-vendored from mas-bandwidth/serialize $tag ($(git -C "$scratch/serialize" rev-parse HEAD))"
git status --short -- STANDARD.md conformance conformance-controls
