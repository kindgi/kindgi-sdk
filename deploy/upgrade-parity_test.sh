#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.
#
# The two modules' upgrade scripts share code without sharing a file: each
# module folder works on its own when it's copied. The code they share sits
# in each script between
#
#     # >>> same in both modules: <name>
#     # <<<
#
# and this test holds each such block to the same bytes in both scripts. It
# fails on a block that differs, a block in only one script, a script with
# no block, a name used twice, a marker without its pair, and a line that
# looks like a marker but isn't one. Run it:
#
#     deploy/upgrade-parity_test.sh [<script> <script>]
#
# With no arguments it compares the Cloud Run and Container Apps scripts.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
A="${1:-$HERE/gcp-cloud-run/upgrade.sh}"
B="${2:-$HERE/azure-container-apps/upgrade.sh}"
for f in "$A" "$B"; do
  [[ -f $f ]] || { echo "can't find $f" >&2; exit 1; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Each block's lines, the markers left out, into $2/<name>. Says what's wrong
# with the markers and returns 1 if anything is.
extract() {
  mkdir -p "$2"
  awk -v dir="$2" '
    function bad(msg) { printf "%s:%d: %s\n", FILENAME, FNR, msg > "/dev/stderr"; failed = 1 }
    /^# >>> same in both modules: / {
      if (name != "") { bad("a block opens inside the block \"" name "\""); close(path) }
      name = substr($0, length("# >>> same in both modules: ") + 1)
      if (name !~ /^[a-z0-9][a-z0-9-]*$/) { bad("a block name is lowercase letters, digits and dashes: \"" name "\""); name = "" ; next }
      if (name in seen) { bad("the block \"" name "\" is there twice"); name = ""; next }
      seen[name] = 1; blocks++; path = dir "/" name; printf "" > path
      next
    }
    /^# <<<$/ {
      if (name == "") bad("a \"# <<<\" closes no block")
      else close(path)
      name = ""
      next
    }
    /^# (>>>|<<<)/ { bad("a line that looks like a marker but isn'"'"'t one: " $0); next }
    name != "" { print > path }
    END {
      if (name != "") bad("the block \"" name "\" never closes")
      if (blocks == 0) bad("no block")
      exit failed
    }
  ' "$1"
}

status=0
extract "$A" "$TMP/a" || status=1
extract "$B" "$TMP/b" || status=1

same=0
for f in "$TMP"/a/*; do
  [[ -e $f ]] || continue
  name="${f##*/}"
  if [[ ! -e $TMP/b/$name ]]; then
    echo "the block \"$name\" is in $A only" >&2
    status=1
  elif cmp -s "$f" "$TMP/b/$name"; then
    same=$((same + 1))
  else
    echo "the block \"$name\" differs (- $A, + $B):" >&2
    diff -u "$f" "$TMP/b/$name" | sed -n '3,40p' >&2
    status=1
  fi
done
for f in "$TMP"/b/*; do
  [[ -e $f ]] || continue
  name="${f##*/}"
  if [[ ! -e $TMP/a/$name ]]; then
    echo "the block \"$name\" is in $B only" >&2
    status=1
  fi
done

if [[ $status -eq 0 ]]; then
  printf 'parity: %d blocks the same in both scripts\n' "$same"
else
  printf 'parity: FAILED (%d blocks the same)\n' "$same" >&2
fi
exit "$status"
