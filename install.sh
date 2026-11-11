#!/bin/sh
# kitespan's installer (DESIGN-I1 2): run as
#   curl -fsSL https://github.com/wannaFlyKa/kitespan/releases/latest/download/install.sh | sh
# or as `sh install.sh` from a checkout or an unpacked release. It checks first and changes nothing until every check
# has passed. Then it fetches a release's source archive and SHA256SUMS, checks the archive, unpacks it beside the
# versions already installed, installs its packages from the lockfile (production ones, no optional ones) and builds
# its page there, and only then switches kitespan's link to it. It keeps the version that kitespan starts, the one
# before it and any version that runs now.
#
# It never uses sudo; it installs neither Bun nor Claude Code nor anything else; it never edits a shell's startup file;
# it writes only ~/.local/bin/kitespan and kitespan's data folder (versions/ and the current link there), and never
# touches kitespan's state or config. Every command is in a function, and the last line calls main, so a download cut
# short runs nothing. POSIX sh only.
#
# Usage: sh install.sh [--list | --uninstall]   (sh install.sh --help)

set -eu
umask 077

RELEASES=https://github.com/wannaFlyKa/kitespan/releases  # shared/release.ts RELEASES_URL
BUN_MIN=1.3.14                                          # package.json devDependencies @types/bun
CLAUDE_MIN=2.1.296                                      # server/agents/claude/background.ts CLAUDE_CODE_MINIMUM
ARCHIVE_MAX=104857600                                   # 100 MiB: the most it downloads or copies of an archive
UNPACKED_MAX=209715200                                  # 200 MiB: the most an archive may unpack to
SUMS_MAX=65536                                          # shared/release.ts SUMS_MAX_BYTES
ENTRIES_MAX=20000                                       # the most entries an archive may hold

say() {
  printf '%s\n' "$1"
}

complain() {
  printf 'install.sh: %s\n' "$1" >&2
}

# A check refused: nothing changed.
refuse() {
  complain "$1"
  exit 1
}

usage_error() {
  complain "$1 (usage: sh install.sh [--list | --uninstall])"
  exit 2
}

# A step failed: the trap removes the staging folder and the lock, and the version that kitespan starts stays.
step_fail() {
  complain "step $1 of 3 failed: $2; kitespan did not change."
  exit 3
}

usage() {
  say 'Usage: sh install.sh [--list | --uninstall]'
  say "Installs the latest kitespan release into $versions and makes $link start it."
  say '  KITESPAN_VERSION=<x.y.z>      install that release instead of the latest (an older one to go back)'
  say '  KITESPAN_INSTALL_FROM=<path>  install from a folder with SHA256SUMS and kitespan-<x.y.z>.tar.gz, or from one such'
  say '                                archive, with no download'
  say '  --list                        list the installed versions'
  say "  --uninstall                   remove $link and $versions; your chats, settings and config stay"
}

# A release's version: three numbers, no leading zero, nothing after them (shared/release.ts RELEASE_VERSION).
is_version() {
  case $1 in
    '' | *[!0-9.]*) return 1 ;;
  esac
  printf '%s\n' "$1" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
}

# The first three numbers in a line (x.y.z), or nothing.
three_numbers() {
  printf '%s\n' "$1" | awk '{ if (match($0, /[0-9]+\.[0-9]+\.[0-9]+/)) { print substr($0, RSTART, RLENGTH); exit } }'
}

# True when x.y.z is min or later, on the three numbers.
at_least() {
  awk -v a="$1" -v b="$2" 'BEGIN { split(a, x, "."); split(b, y, "."); for (i = 1; i <= 3; i++) if (x[i] + 0 != y[i] + 0) exit !(x[i] + 0 > y[i] + 0); exit 0 }'
}

# A folder's real path (every link and .. resolved), or a failure. Only in $(...): it changes the folder.
real_dir() {
  CDPATH='' cd -P -- "$1" 2>/dev/null && pwd -P
}

# The folders (DESIGN-I1 2.3), by the server's XDG rule: a variable counts only when it is an absolute path.
places() {
  case ${HOME-} in
    /*) ;;
    *) refuse 'HOME must be an absolute path.' ;;
  esac
  case ${XDG_DATA_HOME-} in
    /*) kit=$XDG_DATA_HOME/kitespan ;;
    *) kit=$HOME/.local/share/kitespan ;;
  esac
  case ${XDG_STATE_HOME-} in
    /*) state=$XDG_STATE_HOME/kitespan ;;
    *) state=$HOME/.local/state/kitespan ;;
  esac
  case ${XDG_CONFIG_HOME-} in
    /*) config=$XDG_CONFIG_HOME/kitespan ;;
    *) config=$HOME/.config/kitespan ;;
  esac
  versions=$kit/versions
  current=$kit/current
  lock=$versions/.lock
  staging=$versions/.staging
  trash=$versions/.removing
  bindir=$HOME/.local/bin
  link=$bindir/kitespan
}

# True when $link is kitespan's link: a symbolic link to current in a folder whose real path is $kit's.
is_our_link() {
  [ -L "$link" ] || return 1
  to=$(readlink -- "$link") || return 1
  case $to in
    */current) ;;
    *) return 1 ;;
  esac
  [ "$to" = "$current" ] && return 0
  case $to in
    /*) to_dir=${to%/current} ;;
    *) to_dir=$bindir/${to%/current} ;;
  esac
  a=$(real_dir "$to_dir") || return 1
  b=$(real_dir "$kit") || return 1
  [ "$a" = "$b" ]
}

# The version that current names (versions/<v>/bin/kitespan), or nothing.
current_version() {
  [ -L "$current" ] || return 0
  to=$(readlink -- "$current") || return 0
  case $to in
    versions/*/bin/kitespan) ;;
    *) return 0 ;;
  esac
  to=${to#versions/}
  to=${to%/bin/kitespan}
  if is_version "$to"; then printf '%s\n' "$to"; fi
  return 0
}

# The installed versions, newest first: the folders of versions/ whose names pass the version rule.
installed_versions() {
  [ -d "$versions" ] || return 0
  for d in "$versions"/*; do
    n=${d##*/}
    if is_version "$n" && [ -d "$d" ] && [ ! -L "$d" ]; then printf '%s\n' "$n"; fi
  done | sort -t. -k1,1nr -k2,2nr -k3,3nr
}

# The processes as "<pid> <arguments>" lines from /proc, on Linux, for when ps cannot list them (an image without
# procps); a failure elsewhere.
proc_args() {
  [ "$(uname -s 2>/dev/null)" = Linux ] && [ -r /proc/self/cmdline ] || return 1
  for p in /proc/[0-9]*; do
    a=$(tr '\000' ' ' 2>/dev/null <"$p/cmdline") || continue
    if [ -n "$a" ]; then printf '%s %s\n' "${p#/proc/}" "$a"; fi
  done
}

# The kitespan processes that run from a version folder now, as "<pid> <version>" lines in $running: a line of ps (or of
# /proc) whose arguments hold <the real path of versions>/<version>/server/ (a server's arguments name
# <root>/server/main.ts with its real root). ps_ok=no when neither ps nor /proc can list the processes.
list_running() {
  running=''
  ps_ok=yes
  [ -d "$versions" ] || return 0
  real=$(real_dir "$versions") || return 0
  procs=$(ps -A -o pid= -o args= 2>/dev/null) || procs=$(proc_args) || {
    ps_ok=no
    return 0
  }
  running=$(printf '%s\n' "$procs" | P="$real/" awk '
    {
      rest = $0
      p = ENVIRON["P"]
      while ((i = index(rest, p)) > 0) {
        rest = substr(rest, i + length(p))
        j = index(rest, "/")
        if (j > 1 && substr(rest, j + 1, 7) == "server/") {
          v = substr(rest, 1, j - 1)
          if (v ~ /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/) { print $1, v; break }
        }
      }
    }')
}

# True when version $1 runs now (list_running first).
runs() {
  printf '%s\n' "$running" | awk -v w="$1" '$2 == w { found = 1 } END { exit !found }'
}

# The checks of an install, in order (DESIGN-I1 2.7): each refusal is exit 1, and nothing has changed yet.
check_install() {
  os=$(uname -s 2>/dev/null) || os=''
  case $os in
    Linux | Darwin) ;;
    *) refuse "kitespan runs on Linux and macOS only; this system is ${os:-unknown}." ;;
  esac

  want=''
  if [ -n "${KITESPAN_VERSION-}" ]; then
    want=${KITESPAN_VERSION#v}
    is_version "$want" || refuse "KITESPAN_VERSION must be a version such as 0.1.0, not \"$KITESPAN_VERSION\"."
  fi

  from_dir=''
  from_version=''
  if [ -n "${KITESPAN_INSTALL_FROM-}" ]; then
    from=$KITESPAN_INSTALL_FROM
    case $from in
      /*) ;;
      *) refuse "KITESPAN_INSTALL_FROM must be an absolute path, not \"$from\"." ;;
    esac
    while :; do
      case $from in
        / | *[!/]) break ;;
      esac
      from=${from%/}
    done
    name=${from##*/}
    w=${name#kitespan-}
    w=${w%.tar.gz}
    if [ -d "$from" ] && [ -f "$from/SHA256SUMS" ]; then
      from_dir=$from
    elif [ -f "$from" ] && [ "$name" = "kitespan-$w.tar.gz" ] && is_version "$w" && [ -f "${from%/*}/SHA256SUMS" ]; then
      from_dir=${from%/*}
      from_dir=${from_dir:-/}
      from_version=$w
    else
      refuse "KITESPAN_INSTALL_FROM names $KITESPAN_INSTALL_FROM, which is neither a folder with SHA256SUMS nor a kitespan-<x.y.z>.tar.gz file with SHA256SUMS beside it."
    fi
    if [ -n "$from_version" ] && [ -n "$want" ] && [ "$want" != "$from_version" ]; then
      refuse "KITESPAN_VERSION is $want, but KITESPAN_INSTALL_FROM names kitespan-$from_version.tar.gz."
    fi
  fi

  fetcher=''
  if [ -z "$from_dir" ]; then
    if command -v curl >/dev/null 2>&1; then
      fetcher=curl
    elif command -v wget >/dev/null 2>&1; then
      fetcher=wget
    else
      refuse 'it needs curl or wget to download the release.'
    fi
  fi
  if ! command -v tar >/dev/null 2>&1 || ! command -v gzip >/dev/null 2>&1; then
    refuse 'it needs tar and gzip to unpack the release.'
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    hasher=sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    hasher=shasum
  else
    refuse 'it needs sha256sum or shasum to check the download.'
  fi

  command -v bun >/dev/null 2>&1 ||
    refuse "kitespan needs Bun $BUN_MIN or later, and there is no bun on your PATH. Install Bun (https://bun.com/docs/installation), then run this again."
  bun_line=''
  if bun_out=$(bun --version 2>/dev/null </dev/null); then
    bun_line=$(printf '%s\n' "$bun_out" | sed -n 1p)
  fi
  bun_version=$(three_numbers "$bun_line")
  if [ -z "$bun_version" ]; then
    refuse "kitespan needs Bun $BUN_MIN or later; the bun on your PATH printed no version. Update Bun (https://bun.com/docs/installation), then run this again."
  fi
  at_least "$bun_version" "$BUN_MIN" ||
    refuse "kitespan needs Bun $BUN_MIN or later; the bun on your PATH is $bun_line. Update Bun (https://bun.com/docs/installation), then run this again."

  check_folders

  if [ -e "$bindir" ] || [ -L "$bindir" ]; then
    [ -d "$bindir" ] || refuse "$bindir is not a folder."
  fi
  if [ -e "$link" ] || [ -L "$link" ]; then
    is_our_link || refuse "$link is there and is not kitespan's link, so install.sh does not replace it. Move it away, then run this again."
  fi
}

# Checks 12 and 13: kitespan's folder and its versions folder are folders (not links: the server's rule for its
# folders), and current is a link that does not lead to a folder (mv could not replace that one).
check_folders() {
  for d in "$kit" "$versions"; do
    if [ -e "$d" ] || [ -L "$d" ]; then
      if [ -L "$d" ] || [ ! -d "$d" ]; then refuse "$d must be a folder of yours, not a link or a file."; fi
    fi
  done
  if [ -e "$current" ] || [ -L "$current" ]; then
    if [ ! -L "$current" ] || [ -d "$current" ]; then refuse "$current is not kitespan's link, so install.sh does not touch it."; fi
  fi
}

# The lock (DESIGN-I1 2.8): a folder made with mkdir, holding this run's pid. A lock whose process is gone is stale.
take_lock() {
  mkdir -p -- "$versions" || refuse "$versions could not be made."
  trap cleanup EXIT
  trap stopped INT TERM HUP
  if ! mkdir -- "$lock" 2>/dev/null; then
    holder=''
    if [ -f "$lock/pid" ]; then
      holder=$(sed -n 1p "$lock/pid")
      case $holder in
        '' | *[!0-9]*) holder='' ;;
      esac
    fi
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      refuse "another install of kitespan runs now (process $holder, $lock). Wait for it to end, then run this again."
    fi
    rm -rf -- "$lock"
    mkdir -- "$lock" 2>/dev/null ||
      refuse "another install of kitespan runs now (process unknown, $lock). Wait for it to end, then run this again."
  fi
  made_lock=yes
  printf '%s\n' "$$" >"$lock/pid"
  # What a removal that was stopped half way left (discard).
  rm -rf -- "$trash" || :
}

# Removes the version folder $1 so that no half of it is ever left under a version's name, which install.sh would take
# for a whole install: one rename to .removing first, then the removal. A stop in the middle leaves only .removing,
# which the next run removes (take_lock). Only the lock's holder calls it.
discard() {
  rm -rf -- "$trash"
  if [ -e "$trash" ] || [ -L "$trash" ]; then return 1; fi
  mv -- "$versions/$1" "$trash" || return 1
  rm -rf -- "$trash" || :
}

cleanup() {
  if [ -n "$watch_pid" ]; then
    kill "$watch_pid" 2>/dev/null || :
    watch_pid=''
  fi
  if [ "$made_staging" = yes ]; then
    rm -rf -- "$staging"
    made_staging=no
  fi
  if [ "$made_lock" = yes ]; then
    rm -rf -- "$lock"
    made_lock=no
  fi
}

stopped() {
  trap '' INT TERM HUP
  cleanup
  complain "$stop_line"
  exit 130
}

# The Claude Code line (rows 118, 119; the server's own words, shared/protocol.ts): never a stop. `claude --version` runs
# in the background with its output in the lock folder, and is ended after 15 s.
claude_line() {
  if ! command -v claude >/dev/null 2>&1; then
    say "There is no claude on your PATH, so no chat can start until there is one: kitespan runs your own Claude Code, $CLAUDE_MIN or later (https://code.claude.com/docs/en/setup)."
    return 0
  fi
  out=$lock/claude-version
  claude --version </dev/null >"$out" 2>/dev/null &
  claude_pid=$!
  (
    sleeper=''
    trap 'if [ -n "$sleeper" ]; then kill "$sleeper" 2>/dev/null; fi; exit 0' TERM
    sleep 15 &
    sleeper=$!
    wait "$sleeper"
    kill "$claude_pid" 2>/dev/null
  ) </dev/null >/dev/null 2>&1 &
  watch_pid=$!
  code=0
  wait "$claude_pid" || code=$?
  kill "$watch_pid" 2>/dev/null || :
  wait "$watch_pid" 2>/dev/null || :
  watch_pid=''
  [ "$code" -eq 0 ] || return 0
  # The first line that is not blank, trimmed, at most 80 characters (server/agents/claude/locate.ts readVersion);
  # then the version as the server shows it: from its three numbers up to a space or a parenthesis.
  shown=$(awk 'NF { sub(/^[ \t]+/, ""); sub(/[ \t\r]+$/, ""); print substr($0, 1, 80); exit }' "$out" |
    awk '{ if (match($0, /[0-9]+\.[0-9]+\.[0-9]+[^ \t()]*/)) print substr($0, RSTART, RLENGTH) }')
  [ -n "$shown" ] || return 0
  core=$(three_numbers "$shown")
  at_least "$core" "$CLAUDE_MIN" && return 0
  if [ "$shown" = "$core" ]; then
    say "Claude Code $shown runs here; kitespan supports $CLAUDE_MIN and later. Run claude update."
  else
    say "Claude Code $shown runs here; kitespan supports $CLAUDE_MIN and later. Update it the way your company provides it."
  fi
}

# True when the file is larger than the limit.
too_big() {
  size=$(wc -c <"$1" | tr -d ' ')
  [ "$size" -gt "$2" ]
}

# Downloads a URL into a file, https only (DESIGN-I1 2.13): <url> <file> <limit> <the limit's words> <name>.
download() {
  if [ "$fetcher" = curl ]; then
    curl --proto =https --tlsv1.2 -fsSL --retry 2 --connect-timeout 10 --speed-limit 1000 --speed-time 10 --max-filesize "$3" -o "$2" "$1" </dev/null || {
      code=$?
      if [ "$code" -eq 63 ]; then step_fail 1 "$5 is larger than $4"; fi
      step_fail 1 "could not download $1 (curl exit $code)"
    }
  else
    wget --https-only --secure-protocol=TLSv1_2 -q --timeout=10 --tries=3 -O "$2" "$1" </dev/null || {
      code=$?
      step_fail 1 "could not download $1 (wget exit $code)"
    }
  fi
  if too_big "$2" "$3"; then step_fail 1 "$5 is larger than $4"; fi
}

# Copies a local release's file (KITESPAN_INSTALL_FROM): <path> <file> <limit> <the limit's words> <name>.
copy_in() {
  [ -f "$1" ] || step_fail 1 "there is no file $1"
  if too_big "$1" "$3"; then step_fail 1 "$5 is larger than $4"; fi
  cp -- "$1" "$2" || {
    code=$?
    step_fail 1 "could not copy $1 (cp exit $code)"
  }
}

# The newest version that SHA256SUMS lists an archive line for (shared/release.ts newestInSums).
newest_in() {
  tr -d '\r' <"$1" |
    grep -E '^[0-9a-f]{64}  kitespan-(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.tar\.gz$' |
    sed 's/^.*  kitespan-//; s/\.tar\.gz$//' |
    sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1
}

# The SHA-256 that SHA256SUMS gives for kitespan-<v>.tar.gz, or nothing.
digest_in() {
  tr -d '\r' <"$1" | awk -v n="kitespan-$2.tar.gz" '
    length($0) == 66 + length(n) && substr($0, 65, 2) == "  " && substr($0, 67) == n && substr($0, 1, 64) ~ /^[0-9a-f]+$/ {
      print substr($0, 1, 64)
      exit
    }'
}

sha256_of() {
  if [ "$hasher" = sha256sum ]; then
    sha256sum <"$1"
  else
    shasum -a 256 <"$1"
  fi | awk '{ print tolower($1); exit }'
}

# Step 1: SHA256SUMS, the version, the archive and its checks, the unpack. Sets v and again (yes when that version is
# installed already: then the steps are skipped, or the whole run when current names it and the link is kitespan's).
fetch() {
  rm -rf -- "$staging"
  mkdir -- "$staging" || step_fail 1 "$staging could not be made"
  made_staging=yes

  sums=$staging/SHA256SUMS
  if [ -n "$from_dir" ]; then
    say "Step 1 of 3, fetch: $from_dir/SHA256SUMS"
    copy_in "$from_dir/SHA256SUMS" "$sums" "$SUMS_MAX" '64 KiB' SHA256SUMS
  else
    if [ -n "$want" ]; then url=$RELEASES/download/v$want/SHA256SUMS; else url=$RELEASES/latest/download/SHA256SUMS; fi
    say "Step 1 of 3, fetch: $url"
    download "$url" "$sums" "$SUMS_MAX" '64 KiB' SHA256SUMS
  fi

  if [ -n "$want" ]; then
    v=$want
  elif [ -n "$from_version" ]; then
    v=$from_version
  else
    v=$(newest_in "$sums")
    [ -n "$v" ] || step_fail 1 'SHA256SUMS lists no kitespan archive'
  fi
  expected=$(digest_in "$sums" "$v")
  [ -n "$expected" ] || step_fail 1 "SHA256SUMS has no line for kitespan-$v.tar.gz"

  if [ -d "$versions/$v" ] && [ ! -L "$versions/$v" ]; then
    if [ "$(current_version)" = "$v" ] && is_our_link; then
      say "kitespan $v is installed already in $versions/$v; nothing changed."
      exit 0
    fi
    say "kitespan $v is installed already in $versions/$v."
    again=yes
    return 0
  fi

  archive=$staging/kitespan-$v.tar.gz
  if [ -n "$from_dir" ]; then
    say "Step 1 of 3, fetch: $from_dir/kitespan-$v.tar.gz"
    copy_in "$from_dir/kitespan-$v.tar.gz" "$archive" "$ARCHIVE_MAX" '100 MiB' "kitespan-$v.tar.gz"
  else
    url=$RELEASES/download/v$v/kitespan-$v.tar.gz
    say "Step 1 of 3, fetch: $url"
    download "$url" "$archive" "$ARCHIVE_MAX" '100 MiB' "kitespan-$v.tar.gz"
  fi

  actual=$(sha256_of "$archive")
  if [ "$actual" != "$expected" ]; then
    rm -f -- "$archive"
    step_fail 1 "the SHA-256 of kitespan-$v.tar.gz is $actual, not $expected as SHA256SUMS says, so the download was removed"
  fi
  size=$(gzip -dc <"$archive" 2>/dev/null | wc -c | tr -d ' ')
  [ "$size" -le "$UNPACKED_MAX" ] || step_fail 1 "kitespan-$v.tar.gz unpacks to more than 200 MiB"
  names=$(tar -tzf "$archive") || {
    code=$?
    step_fail 1 "tar exited $code"
  }
  count=$(printf '%s\n' "$names" | wc -l | tr -d ' ')
  [ "$count" -le "$ENTRIES_MAX" ] || step_fail 1 "kitespan-$v.tar.gz holds more than $ENTRIES_MAX entries"
  outside=$(printf '%s\n' "$names" | awk -v top="kitespan-$v/" '
    $0 == "" { next }
    substr($0, 1, length(top)) != top || $0 ~ /(^|\/)\.\.(\/|$)/ { print; exit }')
  [ -z "$outside" ] || step_fail 1 "kitespan-$v.tar.gz holds $outside, which is outside kitespan-$v/"
  long=$(tar -tvzf "$archive") || {
    code=$?
    step_fail 1 "tar exited $code"
  }
  odd=$(printf '%s\n' "$long" | awk '$0 != "" && !/^[-d]/ { print; exit }')
  [ -z "$odd" ] || step_fail 1 "kitespan-$v.tar.gz holds a link or a special file: $odd"
  # The sizes that the entries declare, summed: a sparse file's is its whole size, though its tar stream is small. GNU
  # tar and busybox list "<mode> <owner>/<group> <size> ...", bsdtar "<mode> <links> <owner> <group> <size> ...".
  declared=$(printf '%s\n' "$long" | awk -v max="$UNPACKED_MAX" '
    $0 == "" { next }
    {
      s = index($2, "/") ? $3 : $5
      if (s !~ /^[0-9]+$/) { print "unread " $0; exit }
      t += s
      if (t > max) { print "big"; exit }
    }')
  case $declared in
    big) step_fail 1 "kitespan-$v.tar.gz unpacks to more than 200 MiB" ;;
    unread*) step_fail 1 "tar -tvzf lists an entry of kitespan-$v.tar.gz with no size that install.sh can read: ${declared#unread }" ;;
  esac
  tar -xzf "$archive" -C "$staging" || {
    code=$?
    step_fail 1 "tar exited $code"
  }
  dir=$staging/kitespan-$v
  [ -f "$dir/package.json" ] || step_fail 1 "kitespan-$v.tar.gz holds no kitespan-$v/package.json"
  # Run as root, tar keeps the archive's modes and not the umask's: the unpacked files are the user's alone either way.
  chmod -R go-rwx "$dir" || step_fail 1 "chmod -R go-rwx $dir failed"
  pkg_version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*$/\1/p' "$dir/package.json" | sed -n 1p)
  [ "$pkg_version" = "$v" ] || step_fail 1 "kitespan-$v.tar.gz holds version $pkg_version in its package.json, not $v"
  [ -f "$dir/install.sh" ] || step_fail 1 "kitespan-$v.tar.gz holds no kitespan-$v/install.sh"
}

# Steps 2 and 3, then the version folder takes its name.
build() {
  say 'Step 2 of 3, install: bun install --frozen-lockfile --omit=optional --production'
  bun install --cwd "$dir" --frozen-lockfile --omit=optional --production </dev/null || {
    code=$?
    step_fail 2 "bun install --frozen-lockfile --omit=optional --production exited $code"
  }
  say 'Step 3 of 3, build: bun run build'
  bun run --cwd "$dir" build </dev/null || {
    code=$?
    step_fail 3 "bun run build exited $code"
  }
  if [ ! -f "$dir/dist/web/index.html" ] || [ ! -f "$dir/dist/web/build.json" ]; then step_fail 3 'the build wrote no page'; fi
  if [ -e "$versions/$v" ] || [ -L "$versions/$v" ] || ! mv -- "$dir" "$versions/$v"; then
    step_fail 3 "kitespan $v could not be moved into $versions/$v"
  fi
  rm -rf -- "$staging"
  made_staging=no
}

# The switch: current names the new version, by one rename of a new link over it.
switch() {
  previous=$(current_version)
  rm -f -- "$kit/.current.new"
  if ! ln -s "versions/$v/bin/kitespan" "$kit/.current.new" || ! mv -f -- "$kit/.current.new" "$current"; then
    rm -f -- "$kit/.current.new"
    complain "could not switch $current to $v; kitespan did not change."
    exit 3
  fi
  stop_line="stopped after the switch to kitespan $v."
  if [ ! -e "$link" ] && [ ! -L "$link" ]; then
    if ! mkdir -p -- "$bindir" || ! ln -s "$current" "$link"; then
      complain "could not make the link $link to $current."
      exit 3
    fi
  fi
}

# The versions kept: the new current, the one before it, and every version that runs now. When neither ps nor /proc can
# list the processes, nothing goes.
prune() {
  list_running
  [ "$ps_ok" = yes ] || return 0
  for w in $(installed_versions); do
    if [ "$w" = "$v" ] || [ "$w" = "$previous" ] || runs "$w"; then continue; fi
    if discard "$w"; then
      say "Removed kitespan $w: install.sh keeps the version that kitespan starts and the one before it."
    fi
  done
}

last_lines() {
  if [ "$again" = yes ]; then
    say "$link starts kitespan $v now."
  else
    say "kitespan $v is installed in $versions/$v; $link starts it."
  fi
  for w in $(printf '%s\n' "$running" | awk 'NF && !seen[$2]++ { print $2 }'); do
    if [ "$w" != "$v" ]; then say "kitespan $w runs now: restart it to run $v (Settings > About > Restart, or kitespan restart)."; fi
  done
  case ":${PATH-}:" in
    *":$bindir:"*) say 'Start it: kitespan' ;;
    *)
      say "$bindir is not on your PATH. Add this line to your shell's startup file (for example ~/.profile, ~/.bashrc or ~/.zshrc), then open a new terminal:"
      say '  export PATH="$HOME/.local/bin:$PATH"'
      say "Start it: $link"
      ;;
  esac
}

list_versions() {
  list_running
  cur=$(current_version)
  found=no
  for w in $(installed_versions); do
    marks=''
    if [ "$w" = "$cur" ]; then marks=current; fi
    if runs "$w"; then marks=${marks:+$marks, }'runs now'; fi
    if [ -n "$marks" ]; then say "$w  $marks"; else say "$w"; fi
    found=yes
  done
  if [ "$found" = no ]; then say "No kitespan is installed in $versions."; fi
}

uninstall() {
  check_folders
  if ! is_our_link && [ ! -e "$current" ] && [ ! -L "$current" ] && [ ! -e "$versions" ]; then
    say "kitespan is not installed in $versions; nothing to remove."
    exit 0
  fi
  list_running
  [ "$ps_ok" = yes ] || refuse 'ps cannot list the processes here, so install.sh cannot tell whether kitespan runs now; nothing is removed.'
  if [ -n "$running" ]; then
    first=$(printf '%s\n' "$running" | sed -n 1p)
    refuse "kitespan ${first#* } runs now (process ${first%% *}); stop it, then run this again."
  fi
  take_lock
  stop_line='stopped before --uninstall finished; run it again to remove the rest.'
  if is_our_link; then
    rm -f -- "$link"
  elif [ -e "$link" ] || [ -L "$link" ]; then
    complain "$link is not kitespan's link, so it stays."
  fi
  rm -f -- "$current" "$kit/.current.new"
  # Each version by discard, so a stop in the middle leaves whole versions only; then the rest of the folder.
  for w in $(installed_versions); do
    discard "$w" || {
      complain "$versions/$w could not be removed; run this again."
      exit 1
    }
  done
  rm -rf -- "$versions"
  made_lock=no
  rmdir -- "$kit" 2>/dev/null || :
  say "kitespan is uninstalled: $link and $versions are removed."
  say "Your own files stay: chats, drafts, settings and logs in $state, your config in $config, and kitespan's records of worktrees in $kit. Remove them yourself if you want them gone."
}

main() {
  made_lock=no
  made_staging=no
  watch_pid=''
  again=no
  previous=''
  running=''
  stop_line='stopped; kitespan did not change.'
  case $#:${1-} in
    0:) mode=install ;;
    1:--list | 1:--uninstall | 1:--help | 1:-h) mode=$1 ;;
    1:*) usage_error "unknown option $1" ;;
    *) usage_error 'one option at most' ;;
  esac
  places
  case $mode in
    --list) list_versions ;;
    --uninstall) uninstall ;;
    --help | -h) usage ;;
    install)
      check_install
      take_lock
      claude_line
      fetch
      if [ "$again" = no ]; then build; fi
      switch
      prune
      last_lines
      ;;
  esac
}

main "$@"
