#!/bin/sh
# kitespan's Homebrew trial (DESIGN-I1 5.4), for release.yml's brew job on a macOS runner, before the release exists:
# the release folder's formula in a local tap, with its url pointed at the folder's archive, built from source, tested,
# started, then audited with its real url. It never pushes a tap; Homebrew refuses a formula from a file path by
# default, hence the local tap. Not `brew audit --new` (it judges homebrew-core's rules) and not `--online` (the url does
# not exist before the release).
#
# Usage: sh scripts/brew-trial.sh <release folder> <port>
#
# 1. brew tap-new --no-git kitespan/local; tap=$(brew --repository kitespan/local); mkdir -p "$tap/Formula"
# 2. the release's kitespan.rb with its url line replaced by url "file://<folder>/kitespan-<v>.tar.gz", as
#    $tap/Formula/kitespan.rb
# 3. brew install --build-from-source kitespan/local/kitespan   (a fully qualified install trusts that formula)
# 4. brew test kitespan/local/kitespan
# 5. sh scripts/install-trial.sh start "$(brew --prefix)/bin/kitespan" <port> <folder>
# 6. the release's kitespan.rb as it is (its real url) back in $tap/Formula, then brew audit --strict kitespan/local/kitespan
#
# Each step prints `brew-trial: <what>: ok`; the first failure prints `brew-trial: <what> failed` and exits 1; a usage
# error exits 2.

set -eu

TAP=kitespan/local
FORMULA=kitespan/local/kitespan

usage() {
  printf 'brew-trial: %s\nUsage: sh scripts/brew-trial.sh <release folder> <port>\n' "$1" >&2
  exit 2
}

fail() {
  printf 'brew-trial: %s failed\n' "$1" >&2
  exit 1
}

ok() {
  printf 'brew-trial: %s: ok\n' "$1"
}

main() {
  [ "$#" -eq 2 ] || usage "two arguments, the release folder and the port"
  folder=$1
  port=$2
  case $folder in
    /*) ;;
    *) usage "the release folder must be an absolute path, not $folder" ;;
  esac
  case $port in
    '' | *[!0-9]*) usage "the port must be a number, not $port" ;;
  esac
  here=$(CDPATH='' cd -P -- "$(dirname -- "$0")" && pwd -P) || fail "the folder of $0"

  [ -f "$folder/SHA256SUMS" ] || fail "the release folder's SHA256SUMS"
  [ -f "$folder/kitespan.rb" ] || fail "the release folder's kitespan.rb"
  v=$(sed -n 's/^[0-9a-f]\{64\}  kitespan-\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)\.tar\.gz$/\1/p' "$folder/SHA256SUMS" | sed -n 1p)
  [ -n "$v" ] || fail "SHA256SUMS's archive line"
  archive=$folder/kitespan-$v.tar.gz
  [ -f "$archive" ] || fail "the archive $archive"
  # The path goes into a Ruby string and a file URL: only the plain characters of a runner's folder.
  case $archive in
    *[!A-Za-z0-9._/-]*) fail "the archive's path $archive (only letters, digits, dot, dash, underscore and slash)" ;;
  esac
  [ "$(grep -c '^  url "' "$folder/kitespan.rb")" = 1 ] || fail "kitespan.rb's one url line"

  brew tap-new --no-git "$TAP" >/dev/null || fail "brew tap-new --no-git $TAP"
  tap=$(brew --repository "$TAP") || fail "brew --repository $TAP"
  mkdir -p "$tap/Formula"
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      '  url "'*) printf '  url "file://%s"\n' "$archive" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done <"$folder/kitespan.rb" >"$tap/Formula/kitespan.rb"
  ok "the local tap $TAP, its formula's url file://$archive"

  brew install --build-from-source "$FORMULA" || fail "brew install --build-from-source $FORMULA"
  ok "brew install --build-from-source $FORMULA"
  brew test "$FORMULA" || fail "brew test $FORMULA"
  ok "brew test $FORMULA"

  prefix=$(brew --prefix) || fail "brew --prefix"
  sh "$here/install-trial.sh" start "$prefix/bin/kitespan" "$port" "$folder" || fail "the start of $prefix/bin/kitespan"
  ok "the start of $prefix/bin/kitespan"

  cp "$folder/kitespan.rb" "$tap/Formula/kitespan.rb" || fail "the formula with its real url"
  brew audit --strict "$FORMULA" || fail "brew audit --strict $FORMULA"
  ok "brew audit --strict $FORMULA"
}

main "$@"
