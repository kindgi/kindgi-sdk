---
name: kindgi-framework-feedback
description: >
  Capture framework-level feedback about Kindgi/@kindgi/sdk when you
  diagnose a problem that isn't in the pack's own code — SDK type
  drift, API wire schema gaps, adapter regressions, CLI
  friction, skill/code mismatches, misleading errors, UX cliffs.
  Load whenever you have just diagnosed such a problem during pack
  authoring. Also load when the pack author asks you to remove,
  mark-fixed, or re-order entries in FEEDBACK.md — the file is a
  simple markdown list you edit directly with the Edit tool. Distinct
  from authoring skills (which help you build packs) and from
  getting-started (which onboards new packs); this skill turns your
  diagnostic output into durable input for framework improvement.
type: core
library: "@kindgi/sdk"
version: "0.4.1"
sdk_version: "0.0.0"
pack_languages: [node, python, java]
---

# Capturing framework feedback

> **Running `kindgi`:** in a Node project the CLI is a devDependency
> (`@kindgi/cli`), not a global command. Run it through the project's
> package manager — `pnpm exec kindgi …`, `npx --no kindgi …` (npm),
> `yarn kindgi …` or `bun run kindgi …`. A Python pack (`[tool.kindgi]` in
> `pyproject.toml`) has no Node project: run the `kindgi` on `PATH`. A Java
> or Scala pack (`kindgi.config.json`) runs the CLI it pins: `./kindgiw …`.
> Commands below are written `kindgi …` for brevity.

You just spent time diagnosing a Kindgi-framework issue. That diagnostic
is exactly the kind of report the framework maintainers need — file:line
pointers, exact reproducers, honest severity, what you expected vs. what
you observed. **This skill exists to make sure that value doesn't get
lost in the transcript.**

## The mechanism is deliberately simple

One file: `FEEDBACK.md` at the pack root. Each entry is a markdown
section with two identifiers:

- **`id: YYYY-MM-DD.N`** — per-day counter, unique within this pack.
  Used for local navigation and hand-editing ("remove 2026-09-25.3").
- **`hash: feedback-<8-hex>`** — deterministic hash of the
  normalized title. Two packs (or two peers) filing the same issue
  produce the same hash, so p2p sync and framework-side clustering
  work without a central registry.

`kindgi feedback write` appends new entries with both stamps. To mark
an item fixed, add a `> **Fixed:** <note>` line right after its
header. To remove an item, delete the section (including the
trailing `---` separator). All of that is plain markdown editing —
no `kindgi feedback update`, no `kindgi feedback delete`, no
separate tracking database.

## When to file

File an entry when you diagnose:

- **SDK type drift** — a skill or docs claim a field that the SDK's
  `.d.ts` doesn't have (or vice versa).
- **Wire schema gaps** — the API silently drops a field you sent
  (usually `additionalProperties: false` missing a property).
- **Adapter regressions** — behavior changed between rebuilds.
- **CLI friction** — command failures with unhelpful error messages,
  missing verbs, stubs that pretend to work.
- **Skill/code mismatches** — the skill example doesn't work as
  written.
- **Misleading errors** — the error message points at the wrong
  thing.
- **UX cliffs** — the "obvious next step" fails and the recovery
  isn't documented.

Do NOT file when:

- The bug is in the pack's own code (that's a normal debug loop).
- You haven't actually reproduced it — file with `--kind=question`
  instead so it's flagged as unconfirmed.

## How to file — the command

```sh
kindgi feedback write \
  --kind=bug \
  --severity=high \
  --title="preferredProvider silently dropped by wire schema" \
  --authored-by=claude-code \
  --body=@/tmp/report.md
```

Body-input modes:

- `--body=@<file>` — reads the file at path.
- `--body="<literal text>"` — literal content inline. Useful for
  short entries.
- `--body-stdin` — reads from stdin (`diagnose | kindgi feedback write ...`).
- `--interactive` (or omit all of the above) — opens `$EDITOR` with
  a template.

The entry lands as a new `## <title>` section appended to
`FEEDBACK.md`, stamped with a fresh `id: YYYY-MM-DD.N`. The file is
created with a header if it doesn't yet exist.

## Entry shape (what the CLI produces)

```md
## preferredProvider silently dropped by wire schema

- **id:** 2026-09-25.3
- **hash:** feedback-a3f2c1d0
- **kind:** bug
- **severity:** high
- **date:** 2026-09-25T14:32:07.104Z
- **sdk:** 0.1.2 · **cli:** 0.1.2 · **by:** claude-code

### Summary
One-line: what the report is about.

### Observed
What happened, with file:line pointers when possible.

### Expected
What should have happened.

### Reproducer
Exact commands, spec files, output.

### Suggested fix
Optional; leave blank if you don't have one.

---
```

## Editing FEEDBACK.md directly

Entries are referenced locally by their `id` (e.g. `2026-09-25.3`)
or by their title; across packs (or between peers) they are referenced
by their `hash` (e.g. `feedback-a3f2c1d0`). When the pack author says
something like:

- **"Remove 2026-09-25.3"** / **"Remove the preferredProvider
  entry"** → find the section whose `id` matches (or whose `##
  <title>` matches), delete from the header down through the next
  `---` separator (inclusive). Do NOT renumber other entries — ids
  are historical identifiers, gaps are expected.
- **"Mark 2026-09-25.3 fixed"** / **"That preferredProvider one
  landed in commit abc123"** → find the section, insert a line
  right after the header:
  ```md
  > **Fixed:** landed in commit abc123 (2026-09-25). <optional context>
  ```
- **"Note that 2026-09-25.5 is a duplicate of feedback-a3f2c1d0"** /
  **"Merge these — same hash"** → find the section, insert:
  ```md
  > **Duplicate of:** feedback-a3f2c1d0 (<optional context>)
  ```
  Prefer the `hash` when the duplicate lives in another pack (peer /
  framework side); prefer the `id` when it's a local duplicate.
- **Restructuring / re-ordering** → use the Edit tool to move the
  section; keep the header + `- **id:** …` + `- **hash:** …` lines
  intact so both identifiers stay stable.

Do NOT try to re-file the same item through `kindgi feedback write`
— that would create a new entry with a new id (though the hash
would match, which is exactly the p2p-dedup signal). Always edit
directly for maintenance operations within one pack.

## Fields to fill precisely

- **`kind`** — honest classification.
  - `bug` — the framework did the wrong thing (crashed, silently
    dropped a field, contradicted its own docs).
  - `friction` — the framework did the "right" thing but the UX cost
    more time than the task warranted.
  - `question` — you don't understand something and the docs don't
    answer it.
  - `design` — you observed something that works as designed but the
    design might be wrong.

- **`severity`** — honest impact.
  - `blocker` — nothing useful can happen until this is fixed.
  - `high` — a common workflow is broken; users will hit this.
  - `medium` — real friction, but there's a documented workaround.
  - `low` — cosmetic, tiny annoyance, or affects one obscure path.

- **`authored_by`** — `claude-code` when the diagnostic came entirely
  from an AI coding assistant; `human` when the pack author wrote
  it; `mixed` when it's a combination.

## Common mistakes

1. **File-path-only entries** ("bug in router.ts").
   Without a reproducer + expected behavior, the maintainer has to
   reverse-engineer your session. File:line is necessary but not
   sufficient.
2. **Skipping "Suggested fix" when you have one.** If you diagnosed
   the root cause, name it. "Add `preferredProvider` to `AgentSchema`
   in `packages/api/src/openapi/schemas.ts:667`" is worth a dozen
   back-and-forth clarifications.
3. **Bundling multiple bugs into one entry.** Run `kindgi feedback
   write` once per bug. Each gets its own number, its own fix
   status, its own removal path.
4. **Sensitive state in reproducers.** Reproducer sections sometimes
   contain API keys, tenant IDs, secrets — review before committing.
5. **Filing "the way I'd design it" as a bug.** Design disagreements
   are `--kind=design`, not `--kind=bug`. Both are welcome; the
   classification helps prioritization.

## References

- `FEEDBACK.md` at the pack root — the running list itself.
