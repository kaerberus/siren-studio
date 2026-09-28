#!/usr/bin/env bash
# Dev-only: the suites need Node and jsdom. Neither is required to *use* the
# editor, only to run the tests.
#
# Uses whatever `node` is on PATH. If there is none, fetches a standalone Node
# into tests/.node (gitignored) so the repo stays self-contained.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NODE_VERSION="${NODE_VERSION:-v22.20.0}"

if command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
elif [ -x "$HERE/.node/bin/node" ]; then
  NODE="$HERE/.node/bin/node"
else
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)   PKG="node-$NODE_VERSION-linux-x64" ;;
    Linux-aarch64)  PKG="node-$NODE_VERSION-linux-arm64" ;;
    Darwin-arm64)   PKG="node-$NODE_VERSION-darwin-arm64" ;;
    Darwin-x86_64)  PKG="node-$NODE_VERSION-darwin-x64" ;;
    *)
      echo "unsupported platform $(uname -s)-$(uname -m)." >&2
      echo "Install Node $NODE_VERSION yourself and put it on PATH." >&2
      exit 1
      ;;
  esac
  echo "fetching $PKG ..."
  mkdir -p "$HERE/.node"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$PKG.tar.xz" \
    | tar -xJ --strip-components=1 -C "$HERE/.node"
  NODE="$HERE/.node/bin/node"
fi
echo "node: $("$NODE" --version)"

NPM="$(dirname "$NODE")/npm"
if [ ! -x "$NPM" ]; then
  NPM="$(command -v npm || true)"
fi
if [ -z "$NPM" ]; then
  echo "npm not found next to node; cannot install jsdom." >&2
  exit 1
fi

if [ -d "$HERE/node_modules/jsdom" ]; then
  echo "jsdom: already installed"
else
  echo "installing jsdom ..."
  # npm is a node script: its own directory has to be on PATH for it to run,
  # which matters when we just fetched node into tests/.node.
  ( cd "$HERE" && PATH="$(dirname "$NODE"):$PATH" "$NPM" install --silent )
  echo "jsdom: installed"
fi
