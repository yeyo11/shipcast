#!/bin/sh
# Shipcast in one command:
#   curl -fsSL https://raw.githubusercontent.com/yeyo11/shipcast/main/scripts/install.sh | sh
# Clones Shipcast, installs it and runs `shipcast init` (docs/install.md). Needs git, Node 24 with
# corepack (for pnpm) and Docker. SHIPCAST_DIR chooses the folder (./shipcast by default); any
# arguments are passed to `shipcast init`.
set -eu

dir="${SHIPCAST_DIR:-shipcast}"
need() { command -v "$1" >/dev/null 2>&1 || { echo "Shipcast needs $1: $2" >&2; exit 1; }; }
need git "https://git-scm.com"
need node "Node 24 LTS, https://nodejs.org"
need corepack "it ships with Node; run: npm install -g corepack"
need docker "Docker, for the registry's Postgres (or run your own and use --skip-docker)"

if [ -e "$dir" ]; then
  echo "$dir exists already; set SHIPCAST_DIR to install somewhere else, or run 'pnpm shipcast init' inside it." >&2
  exit 1
fi

git clone --depth 1 https://github.com/yeyo11/shipcast.git "$dir"
cd "$dir"
corepack enable
pnpm install --frozen-lockfile
# The pipe gave this script stdin; init asks questions, so it reads the terminal
if [ -t 1 ] && [ -r /dev/tty ]; then
  pnpm shipcast init "$@" < /dev/tty
else
  pnpm shipcast init --yes "$@"
fi
