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
  Also load to send entries to Kindgi (only after the person says yes
  to the preview), to check what became of sent ones at the start of a
  session, or to take one back.
type: core
library: "@kindgi/sdk"
version: "0.5.0"
sdk_version: "0.0.0"
pack_languages: [node, python, java, scala]
---

# Capturing framework feedback

> **Running `kindgi`:** in a Node project the CLI is a devDependency
> (`@kindgi/cli`), not a global command. Run it through the project's
> package manager — `pnpm exec kindgi …`, `npx --no -- kindgi …` (npm),
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

## Your case: read this file

| Your case | Read |
|---|---|
| Filling `kind`, `severity` and `authored_by`, and what an entry looks like | [fields-and-entry-shape.md](fields-and-entry-shape.md) |
| Sending entries to Kindgi: never without the person's yes to the preview | [sending.md](sending.md) |
| What became of sent reports, at the start of a session, or taking one back | [hearing-back.md](hearing-back.md) |
| Removing, marking fixed, marking a duplicate or re-ordering entries in `FEEDBACK.md` | [editing-feedback-file.md](editing-feedback-file.md) |
| Before you file: what makes a report hard to act on | [common-mistakes.md](common-mistakes.md) |

## References

- `FEEDBACK.md` at the pack root — the running list itself.
- `kindgi feedback submit --help`, `status --help` and `withdraw --help`.
