#!/bin/sh
# Update kitespan from its git repository (DESIGN.md 4.10): the same update as Settings > About > Update, run by
# server/update/cli.ts so that its rules live once. It refuses a checkout with local changes, one that is not a git
# checkout or has no upstream, and one that has diverged from origin; then a fast-forward from origin, the locked
# install without optional packages (so the SDK's platform binaries are never installed, 4.7), then the page's build
# beside the build folder, which takes the folder's place only when it finished. It stops at the first step that fails
# and names it. The running server keeps its code and its page until it restarts. It can run in a chat's Terminal pane.
#
# Usage: bin/update.sh [--dist <build folder>]

set -eu

# This script's own file, through any link to it: the folder above it is kitespan's root.
self=$0
hops=0
while [ -L "$self" ]; do
  hops=$((hops + 1))
  if [ "$hops" -gt 32 ]; then
    printf 'update.sh: %s\n' "too many links lead to $0" >&2
    exit 1
  fi
  link=$(readlink -- "$self") || {
    printf 'update.sh: %s\n' "the link $self cannot be read" >&2
    exit 1
  }
  case $link in
    /*) self=$link ;;
    *)
      self=$(CDPATH='' cd -P -- "$(dirname -- "$self")" && pwd -P)/$link || {
        printf 'update.sh: %s\n' "the folder of $self cannot be read" >&2
        exit 1
      }
      ;;
  esac
done
root=$(CDPATH='' cd -P -- "$(dirname -- "$self")/.." && pwd -P)
bun_bin=$(command -v bun) || {
  printf 'update.sh: bun is not on PATH\n' >&2
  exit 1
}

# A relative build folder is the caller's, so it is made absolute here (Bun runs in the repository root).
n=$#
i=0
dist_next=no
while [ "$i" -lt "$n" ]; do
  arg=$1
  if [ "$dist_next" = yes ]; then
    case $arg in
      /*) ;;
      *) arg=$(pwd -P)/$arg ;;
    esac
    dist_next=no
  elif [ "$arg" = --dist ]; then
    dist_next=yes
  fi
  set -- "$@" "$arg"
  shift
  i=$((i + 1))
done

# Bun runs in the repository root, so it reads no bunfig.toml of the folder that the command was typed in.
exec "$bun_bin" "--cwd=$root" --no-env-file "$root/server/update/cli.ts" "$@"
