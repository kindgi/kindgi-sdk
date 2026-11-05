#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.
#
# Turn a saved plan of this module into a test fixture that holds no values
# and no names of the deployment's own: what upgrade.sh's plan check reads,
# and nothing else.
#
# A saved plan holds the variables' values in clear, secret ones too, and so
# does `terraform show -json` of it. This prints neither: it pipes the JSON
# straight into jq, under umask 077, and writes only the fixture. For each
# resource change the fixture keeps its mode, type, name and actions, and its
# after_unknown, which holds no values. A for_each key is the deployment's (a
# pack secret's env name, a bucket's name), so it becomes a placeholder, k1,
# k2 and so on, the same one for the same key, in the index and the address.
# For a change that isn't a no-op or a read the fixture keeps its before and
# after, with every value but null replaced: "same" where before and after
# agree, "before" and "after" where they don't, the way the plan check
# compares them. A database flag keeps its name, and so does an env var the
# runtime reads (KINDGI_...), since the check keys them by it and names some.
# Any other env var's name is the deployment's, so it becomes ENV_1, ENV_2
# and so on, the same one wherever it appears. Nothing else in the plan is
# kept: not its variables, prior state, configuration or outputs. The
# server's image reads "after", so a test that runs the check on a fixture
# puts the image it expects there.
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
# whose entries all have a name stands for that name. A plan made from
# another directory, whose resources sit in a module call, isn't this
# module's, and the fixture says so instead.
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
  def scrub($doc; $mine; $other; $differs; $envs):
    reduce ($doc | paths(scalars)) as $p ($doc;
      ($p | key($doc) | tojson) as $k
      | if getpath($p) == null then .
        elif $p[-1] == "name" and ($p | length) > 2 and ($p[-2] | type) == "number" and keyed($doc; $p[0:-2]) then
          (if $p[-3] == "env" then setpath($p; $envs[getpath($p)] // getpath($p)) else . end)
        elif $mine[$k] == $other[$k] then setpath($p; "same")
        else setpath($p; $differs) end);
  def renumber($prefix): unique | to_entries | map({key: .value, value: "\($prefix)\(.key + 1)"}) | from_entries;
  def index_of($keys): if type == "string" then $keys[.] else . end;
  def suffix($keys): if type == "number" then "[\(.)]" elif type == "string" then "[\"\($keys[.])\"]" else "" end;
  if any(.resource_changes[]?; has("module_address")) then
    {scrub_error: "the plan has resources in a module call: make it from this module directory."}
  else
  ([.resource_changes[]?.change | (.before, .after) | select(. != null)
    | .. | objects | .env? | arrays | .[] | objects | .name | strings
    | select(startswith("KINDGI_") | not)] | renumber("ENV_")) as $envs
  | ([.resource_changes[]?.index | strings] | renumber("k")) as $keys
  | {format_version, terraform_version,
     resource_changes: [.resource_changes[]?
       | {address: ((if .mode == "data" then "data." else "" end) + "\(.type).\(.name)" + (.index | suffix($keys))),
          mode, type, name}
       + (if has("index") then {index: (.index | index_of($keys))} else {} end)
       + {change: (.change as $c
           | {actions: $c.actions, after_unknown: ($c.after_unknown // {})}
           + (if $c.actions == ["no-op"] or $c.actions == ["read"] then {}
              else ($c.before // null) as $b | ($c.after // null) as $a
                | (if $b == null then {} else vals($b) end) as $vb
                | (if $a == null then {} else vals($a) end) as $va
                | {before: (if $b == null then null else scrub($b; $vb; $va; "before"; $envs) end),
                   after: (if $a == null then null else scrub($a; $va; $vb; "after"; $envs) end)}
              end))}]}
  end'

TMP="$(mktemp "$OUT.XXXXXX")"
cleanup() { local code=$?; if [[ -f $TMP ]]; then rm -f "$TMP"; fi; exit "$code"; }
trap cleanup EXIT
# jq's own errors can quote a piece of what it read, so they're not shown.
terraform show -json "$PLAN" | jq "$SCRUB_JQ" 2>/dev/null >"$TMP" \
  || die "couldn't scrub the saved plan: Terraform couldn't read it (see above), or it isn't a plan's JSON. Nothing was written."
if [[ "$(jq -r '.scrub_error // ""' "$TMP")" != "" ]]; then die "$(jq -r '.scrub_error' "$TMP") Nothing was written."; fi
mv "$TMP" "$OUT"
printf 'scrub_plan: wrote %s\n' "$OUT" >&2
