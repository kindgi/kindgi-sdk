#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.
#
# Turn a saved plan of this module into a test fixture that holds no values:
# what upgrade.sh's plan check reads, and nothing else.
#
# A saved plan holds the variables' values in clear, secret ones too, and so
# does `terraform show -json` of it. This prints neither: it pipes the JSON
# straight into jq, under umask 077, and writes only the fixture. For each
# resource change the fixture keeps its address, mode, type, name, index and
# actions, and its after_unknown, which holds no values. For one that isn't
# a no-op or a read it keeps its before and after, with every value but null
# replaced: "same" where before and after agree, "before" and "after" where
# they don't, the way the plan check compares them. An env var or a database
# flag keeps its name, since the check keys them by it. Nothing else in the
# plan is kept: not its variables, prior state, configuration or outputs.
# The server's image reads "after", so a test that runs the check on a
# fixture puts the image it expects there.
#
# Usage, from this module directory, after `terraform init`:
#   tests/scrub_plan.sh <saved plan> <fixture.json>
# It won't write over a file that exists. Delete the saved plan once you're
# done with it.

set -euo pipefail
umask 077

die() { printf 'scrub_plan: %s\n' "$*" >&2; exit 1; }

[[ $# -eq 2 ]] || die "usage: tests/scrub_plan.sh <saved plan> <fixture.json>"
PLAN="$1" OUT="$2"
[[ -f $PLAN ]] || die "no saved plan at $PLAN."
[[ ! -e $OUT ]] || die "$OUT exists: give a file that doesn't."
command -v terraform >/dev/null 2>&1 || die "terraform isn't on PATH."
command -v jq >/dev/null 2>&1 || die "jq isn't on PATH."

# As the plan check keys a path: an index into an env or database_flags list
# whose entries all have a name stands for that name.
readonly SCRUB_JQ='
  def keyed($doc; $p):
    if ($p | length) > 0 and ($p[-1] == "env" or $p[-1] == "database_flags") then
      ($doc | getpath($p)) | type == "array" and all(.[]; type == "object" and (.name | type) == "string")
    else false end;
  def key($doc):
    . as $p
    | reduce range(1; $p | length) as $i ($p;
        if ($p[$i] | type) == "number" and keyed($doc; $p[0:$i])
        then .[$i] = ($doc | getpath($p[0:$i + 1]).name) else . end);
  def vals($doc):
    [$doc | paths(scalars) as $p | {key: ($p | key($doc) | tojson), value: getpath($p)}] | from_entries;
  def scrub($doc; $mine; $other; $differs):
    reduce ($doc | paths(scalars)) as $p ($doc;
      ($p | key($doc) | tojson) as $k
      | if getpath($p) == null then .
        elif $p[-1] == "name" and ($p | length) > 1 and ($p[-2] | type) == "number" and keyed($doc; $p[0:-2]) then .
        elif $mine[$k] == $other[$k] then setpath($p; "same")
        else setpath($p; $differs) end);
  {format_version, terraform_version,
   resource_changes: [.resource_changes[]? | . as $r
     | {address, mode, type, name} + (if has("index") then {index} else {} end)
     + {change: (.change as $c
         | {actions: $c.actions, after_unknown: ($c.after_unknown // {})}
         + (if $c.actions == ["no-op"] or $c.actions == ["read"] then {}
            else ($c.before // null) as $b | ($c.after // null) as $a
              | (if $b == null then {} else vals($b) end) as $vb
              | (if $a == null then {} else vals($a) end) as $va
              | {before: (if $b == null then null else scrub($b; $vb; $va; "before") end),
                 after: (if $a == null then null else scrub($a; $va; $vb; "after") end)}
            end))}]}'

TMP="$(mktemp "$OUT.XXXXXX")"
cleanup() { local code=$?; if [[ -f $TMP ]]; then rm -f "$TMP"; fi; exit "$code"; }
trap cleanup EXIT
terraform show -json "$PLAN" | jq "$SCRUB_JQ" >"$TMP" || die "couldn't read the saved plan with 'terraform show -json'."
mv "$TMP" "$OUT"
printf 'scrub_plan: wrote %s\n' "$OUT" >&2
