#!/bin/sh
# Installs spectacular from a GitHub release of mhoegger/spec-tacular.
#
#   gh api repos/mhoegger/spec-tacular/contents/install.sh \
#     -H 'Accept: application/vnd.github.raw' | sh
#
# SPECTACULAR_VERSION      a release tag such as v0.1.0 (default: the latest release)
# SPECTACULAR_INSTALL_DIR  where the binary goes (default: ~/.local/bin)
#
# Downloads with the GitHub CLI when it is signed in, which is what works
# while the repository is private; otherwise with curl from github.com. The
# archive is checked against the release's SHA256SUMS before anything is
# installed.

set -eu

REPO=mhoegger/spec-tacular
version=${SPECTACULAR_VERSION:-latest}
install_dir=${SPECTACULAR_INSTALL_DIR:-$HOME/.local/bin}

say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "no spectacular build for $(uname -s); build from source instead (see the README)" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "no spectacular build for $(uname -m); build from source instead (see the README)" ;;
esac

# A shell running under Rosetta reports x86_64 on Apple silicon.
if [ "$os" = darwin ] && [ "$arch" = x64 ] &&
  [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

# stdin is closed for every download: when this script is piped into sh,
# stdin is the script itself.
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 </dev/null; then
  if [ "$version" = latest ]; then
    tag=$(gh release view -R "$REPO" --json tagName --jq .tagName </dev/null) ||
      die "could not find the latest release of $REPO"
  else
    tag=$version
  fi
  asset="spectacular-$tag-$os-$arch.tar.gz"
  say "Downloading $asset with gh"
  gh release download "$tag" -R "$REPO" -D "$tmp" -p "$asset" -p SHA256SUMS </dev/null ||
    die "could not download $asset from release $tag"
elif command -v curl >/dev/null 2>&1; then
  if [ "$version" = latest ]; then
    # github.com redirects /releases/latest to /releases/tag/<tag>.
    url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" </dev/null) ||
      die "could not find the latest release of $REPO (a private repository needs gh, signed in)"
    tag=${url##*/}
  else
    tag=$version
  fi
  asset="spectacular-$tag-$os-$arch.tar.gz"
  base="https://github.com/$REPO/releases/download/$tag"
  say "Downloading $asset"
  for file in "$asset" SHA256SUMS; do
    curl -fsSL -o "$tmp/$file" "$base/$file" </dev/null ||
      die "could not download $file from release $tag (a private repository needs gh, signed in)"
  done
else
  die "neither gh nor curl is installed"
fi

# Check the archive against its line in SHA256SUMS.
expected=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || die "$asset is not listed in the release's SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')
fi
[ "$actual" = "$expected" ] || die "checksum mismatch for $asset (expected $expected, got $actual)"

tar -xzf "$tmp/$asset" -C "$tmp"
bin="$tmp/${asset%.tar.gz}/spectacular"
[ -f "$bin" ] || die "$asset does not contain spectacular"

mkdir -p "$install_dir"
# Written beside the target and renamed over it, so a running spectacular is
# never overwritten in place.
cp "$bin" "$install_dir/.spectacular.new"
chmod 755 "$install_dir/.spectacular.new"
mv -f "$install_dir/.spectacular.new" "$install_dir/spectacular"

say "Installed $("$install_dir/spectacular" --version) to $install_dir/spectacular"

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) say "note: $install_dir is not on your PATH; add it to run \`spectacular\` by name." ;;
esac

if ! command -v openspec >/dev/null 2>&1; then
  say "note: spectacular needs the OpenSpec CLI, which is not on your PATH. Install it with:"
  say "  npm i -g @fission-ai/openspec"
fi
