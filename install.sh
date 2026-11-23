#!/bin/sh
# Installs spec-tacular from a GitHub release of wingfold-ai/spec-tacular.
#
#   curl -fsSL https://spec-tacular.app/install.sh | sh
#
# spec-tacular.app serves this same file: website/ copies it at build time.
#
# SPECTACULAR_VERSION      a release tag such as v0.1.0 (default: the latest release)
# SPECTACULAR_INSTALL_DIR  where the binary goes (default: ~/.local/bin)
#
# Downloads with the GitHub CLI when it is signed in (which avoids github.com's
# anonymous rate limits), otherwise with curl from github.com. The
# archive is checked against the release's SHA256SUMS before anything is
# installed.

set -eu

REPO=wingfold-ai/spec-tacular
version=${SPECTACULAR_VERSION:-latest}
install_dir=${SPECTACULAR_INSTALL_DIR:-$HOME/.local/bin}

say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "no spec-tacular build for $(uname -s); build from source instead (see the README)" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "no spec-tacular build for $(uname -m); build from source instead (see the README)" ;;
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
  # Releases up to v0.3.0 named the command, and their archives, `spectacular`.
  for name in spec-tacular spectacular; do
    asset="$name-$tag-$os-$arch.tar.gz"
    # gh succeeds when any pattern matches, so the archive must be there.
    gh release download "$tag" -R "$REPO" -D "$tmp" -p "$asset" -p SHA256SUMS --clobber </dev/null 2>/dev/null &&
      [ -f "$tmp/$asset" ] && break
    asset=
  done
  [ -n "$asset" ] || die "could not download a build for $os-$arch from release $tag"
  say "Downloaded $asset with gh"
elif command -v curl >/dev/null 2>&1; then
  if [ "$version" = latest ]; then
    # github.com redirects /releases/latest to /releases/tag/<tag>.
    url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" </dev/null) ||
      die "could not find the latest release of $REPO"
    tag=${url##*/}
  else
    tag=$version
  fi
  base="https://github.com/$REPO/releases/download/$tag"
  # Releases up to v0.3.0 named the command, and their archives, `spectacular`.
  for name in spec-tacular spectacular; do
    asset="$name-$tag-$os-$arch.tar.gz"
    curl -fsSL -o "$tmp/$asset" "$base/$asset" </dev/null 2>/dev/null && break
    asset=
  done
  [ -n "$asset" ] || die "could not download a build for $os-$arch from release $tag"
  say "Downloaded $asset"
  curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" </dev/null ||
    die "could not download SHA256SUMS from release $tag"
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
bin="$tmp/${asset%.tar.gz}/$name"
[ -f "$bin" ] || die "$asset does not contain $name"

mkdir -p "$install_dir"
# Written beside the target and renamed over it, so a running spec-tacular is
# never overwritten in place.
cp "$bin" "$install_dir/.spec-tacular.new"
chmod 755 "$install_dir/.spec-tacular.new"
mv -f "$install_dir/.spec-tacular.new" "$install_dir/spec-tacular"

say "Installed $("$install_dir/spec-tacular" --version) to $install_dir/spec-tacular"

# Until 0.3.0 the command was `spectacular`: a copy left under that name would
# be a stale version answering to the old name.
if [ -f "$install_dir/spectacular" ]; then
  rm -f "$install_dir/spectacular"
  say "Removed the old \`spectacular\` command: it is \`spec-tacular\` now."
fi

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) say "note: $install_dir is not on your PATH; add it to run \`spec-tacular\` by name." ;;
esac

if ! command -v openspec >/dev/null 2>&1; then
  say "note: spec-tacular needs the OpenSpec CLI, which is not on your PATH. Install it with:"
  say "  npm i -g @fission-ai/openspec            (needs Node.js 22.12 or newer)"
  say "  or OpenSpec's standalone binary: https://openspec.dev"
fi
