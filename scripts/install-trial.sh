#!/bin/sh
# install.sh's trial on a release's own files (DESIGN-I1 2.15): release.yml's install-linux and install-macos jobs run
# the first form on a clean runner, and scripts/brew-trial.sh runs the start form on Homebrew's kitespan. It installs
# into $HOME, starts kitespan on that home's state folder and ends with --uninstall, so run it only in a fresh home (a
# CI runner's own, or a scratch HOME with the XDG folders inside it). The first form refuses, before anything, a home
# with ~/.local/bin/kitespan, or with a data, state or config folder of kitespan or of its old name (whose folders
# kitespan's first start moves), by the XDG rule.
#
# Usage: sh scripts/install-trial.sh <release folder> <port>
#        sh scripts/install-trial.sh start <kitespan command> <port> [<release folder>]
#
# The first form: KITESPAN_INSTALL_FROM=<folder> sh <folder>/install.sh, then ~/.local/bin/kitespan --help and
# --version (the newest version that <folder>/SHA256SUMS lists), the start form on that command, the same install
# again (nothing changes), and --uninstall (the link and the versions go, the state folder stays). The start form: the
# command with --port <port> in the background (with KITESPAN_INSTALL_FROM=<folder> when a folder is given), its
# health and its page on 127.0.0.1, then a stop by the pid it recorded. Each check prints "install-trial: <what>: ok";
# the first failure prints "install-trial: <what> failed" and the output that shows why, and exits 1.

set -eu

usage() {
  printf '%s\n' 'Usage: sh scripts/install-trial.sh <release folder> <port>' \
    '       sh scripts/install-trial.sh start <kitespan command> <port> [<release folder>]' >&2
  exit 2
}

ok() {
  printf 'install-trial: %s: ok\n' "$1"
}

# fail <what> [<a file whose text shows why>]
fail() {
  printf 'install-trial: %s failed\n' "$1" >&2
  if [ -n "${2-}" ] && [ -f "$2" ]; then cat "$2" >&2; fi
  exit 1
}

# The server's pid is still the process this script started: alive, and, where /proc can be read, running
# <root>/server/main.ts (bin/kitespan execs env, which execs Bun, in the same process).
ours() {
  kill -0 "$pid" 2>/dev/null || return 1
  if [ -r "/proc/$pid/cmdline" ]; then
    tr '\0' '\n' <"/proc/$pid/cmdline" | grep -q '/server/main\.ts$' || return 1
  fi
  return 0
}

stop_server() {
  ours || return 1
  kill -TERM "$pid"
  n=0
  while kill -0 "$pid" 2>/dev/null; do
    n=$((n + 1))
    [ "$n" -le 30 ] || return 1
    sleep 0.5
  done
  wait "$pid" 2>/dev/null || :
}

# start <command> <port> [<release folder>]
start() {
  log=$work/server.log
  if [ -n "${3-}" ]; then
    KITESPAN_INSTALL_FROM=$3 "$1" --port "$2" </dev/null >"$log" 2>&1 &
  else
    "$1" --port "$2" </dev/null >"$log" 2>&1 &
  fi
  pid=$!
  base=http://127.0.0.1:$2
  n=0
  until curl --noproxy '*' -fsS -o /dev/null --max-time 2 "$base/api/health" 2>/dev/null; do
    kill -0 "$pid" 2>/dev/null || fail "the start of $1 on port $2" "$log"
    n=$((n + 1))
    if [ "$n" -gt 60 ]; then
      stop_server || :
      fail "GET $base/api/health within 30 s" "$log"
    fi
    sleep 0.5
  done
  ok "GET $base/api/health"
  page=$(curl --noproxy '*' -fsS --max-time 10 "$base/") || {
    stop_server || :
    fail "GET $base/" "$log"
  }
  case $page in
    *'<title>kitespan</title>'*) ok "GET $base/ holds <title>kitespan</title>" ;;
    *)
      stop_server || :
      fail "GET $base/ holding <title>kitespan</title>" "$log"
      ;;
  esac
  stop_server || fail "the stop of process $pid" "$log"
  ok "the stop of process $pid"
}

# The first form: <release folder> <port>
trial() {
  folder=$1
  installer=$folder/install.sh
  out=$work/install.out
  version=$(sed -n 's/^[0-9a-f]\{64\}  kitespan-\([0-9][0-9.]*\)\.tar\.gz$/\1/p' "$folder/SHA256SUMS" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
  [ -n "$version" ] || fail "reading a kitespan archive's line in $folder/SHA256SUMS"
  link=$HOME/.local/bin/kitespan
  case ${XDG_DATA_HOME-} in
    /*) data=$XDG_DATA_HOME ;;
    *) data=$HOME/.local/share ;;
  esac
  case ${XDG_STATE_HOME-} in
    /*) states=$XDG_STATE_HOME ;;
    *) states=$HOME/.local/state ;;
  esac
  case ${XDG_CONFIG_HOME-} in
    /*) configs=$XDG_CONFIG_HOME ;;
    *) configs=$HOME/.config ;;
  esac
  versions=$data/kitespan/versions
  state=$states/kitespan
  # Never in a home of someone's own: kitespan's chats, settings or install there, or the old name's (a start moves them).
  for p in "$link" "$data/kitespan" "$state" "$configs/kitespan" "$data/flydeck" "$states/flydeck" "$configs/flydeck"; do
    if [ -e "$p" ] || [ -L "$p" ]; then
      printf 'install-trial: %s is there already, so this is not a fresh home; nothing changed\n' "$p" >&2
      exit 1
    fi
  done

  KITESPAN_INSTALL_FROM=$folder sh "$installer" >"$out" 2>&1 || fail "the install of kitespan $version" "$out"
  cat "$out"
  ok "the install of kitespan $version"
  "$link" --help >"$out" 2>&1 && grep -q '^Usage: ' "$out" || fail "$link --help" "$out"
  ok "$link --help"
  [ "$("$link" --version 2>&1)" = "kitespan $version" ] || {
    "$link" --version >"$out" 2>&1 || :
    fail "$link --version printing kitespan $version" "$out"
  }
  ok "$link --version"

  start "$link" "$2" "$folder"

  KITESPAN_INSTALL_FROM=$folder sh "$installer" >"$out" 2>&1 || fail "the second install" "$out"
  grep -q "^kitespan $version is installed already in .*; nothing changed\.$" "$out" || fail "the second install saying nothing changed" "$out"
  ok "the second install changes nothing"

  sh "$installer" --uninstall >"$out" 2>&1 || fail "the uninstall" "$out"
  cat "$out"
  if [ -e "$link" ] || [ -L "$link" ] || [ -e "$versions" ]; then fail "the uninstall removing $link and $versions" "$out"; fi
  [ -d "$state" ] || fail "the uninstall keeping $state" "$out"
  ok "the uninstall"
}

main() {
  case ${1-} in
    start) [ "$#" -eq 3 ] || [ "$#" -eq 4 ] || usage ;;
    *) [ "$#" -eq 2 ] || usage ;;
  esac
  work=$(mktemp -d "${TMPDIR:-/tmp}/install-trial.XXXXXX")
  # The work folder goes on every exit, a failure's too.
  trap 'rm -f -- "$work/server.log" "$work/install.out"; rmdir -- "$work"' EXIT
  if [ "$1" = start ]; then start "$2" "$3" "${4-}"; else trial "$1" "$2"; fi
}

main "$@"
