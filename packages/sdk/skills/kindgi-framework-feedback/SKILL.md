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
version: "0.4.4"
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

## Sending it to Kindgi: only with the person's yes

`FEEDBACK.md` stays in the pack until the person decides to send it.
`kindgi feedback submit` sends entries to Kindgi's private intake on
access.kindgi.com. Only Kindgi's maintainers read reports there. They're
kept 90 days, and the person can take one back at any time.

**Never send on your own.** Every time:

1. **Preview.** Run `kindgi feedback submit --preview`, or name entries by
   id or hash: `kindgi feedback submit 2026-09-25.3 --preview`. With none
   named it takes every entry not sent yet and not marked fixed. It prints
   exactly what would be sent, after redaction, and its `digest`. Nothing
   is sent.
2. **Show the person.** Show them each entry's title and body as they'll
   go, and the environment sent with them: the OS, Node and CLI versions,
   the pack's language, and `kindgi doctor`'s checks as id and status
   only. Point out anything redaction missed, like a customer's name or an
   internal host name. If something shouldn't go, edit the entry in
   `FEEDBACK.md` and preview again.
3. **Ask, then send.** Ask "Send this to Kindgi?" Only after a clear yes,
   run the same command with `--yes=<digest>` in place of `--preview`. If
   anything changed since the preview, it refuses: preview and ask again.

If `submit` says "Kindgi may have received it" (the answer was lost, came
too late, or couldn't be read), tell the person, and don't send again on
your own: a second send makes a second report, and one that arrived can't
be withdrawn from this machine. Let them decide.

What redaction takes out before the preview:
- the home directory alone becomes `~`, and paths in the pack become `./…`;
- other absolute paths become `[path]`, a path under `~` too;
- values from the pack's `.env*` files and `.kindgi/secrets.env` become
  `[redacted]`;
- private keys and token shapes become `[redacted]` (a Kindgi token keeps
  its prefix and last four characters);
- a URL keeps its host and path but loses its user info and query values;
- email addresses become `[email]`.

It can't catch everything in free text: the preview is the check.

Once sent, each entry gets a line like
`- **submitted:** 2026-09-25T15:02:11.000Z · **report:** fbr_…`. The
report id isn't a secret, so `FEEDBACK.md` can still be committed. The key
that takes a report back is kept in `~/.kindgi/feedback/keys.json` on this
machine and is never printed. Don't read or copy that file.

If `KINDGI_FEEDBACK_SUBMIT=off` is set, `submit` refuses. That's the
person's or their team's choice, so don't work around it. `write`,
`status` and `withdraw` still work.

## Hearing back

At the start of a session, when `FEEDBACK.md` has submitted entries, run
`kindgi feedback status`. It asks about each report at most once a day,
and never again once it's fixed, won't be fixed, or was withdrawn, or once
the intake doesn't have it (past its 90 days) unless it's named. A fixed
entry gets `> **Fixed:** in <version> (report fbr_…)` under its heading.
Tell the person what changed:
- **fixed**, with the version: suggest upgrading to it;
- **known**, with the public issue when there is one;
- **won't fix**, with the one-line reason.

Name an entry or a report id (`kindgi feedback status 2026-09-25.3`) to
ask about it now. A teammate's report id works too: it isn't a secret.

## Taking one back

When the person asks to withdraw a report, run
`kindgi feedback withdraw <id|hash|reportId>`. The intake clears its text
at once, and the entry's line gets `· **withdrawn:** <date>`. It needs the
key on the machine that sent the report. A withdrawn entry isn't sent again
unless the person names it in `submit`.

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
   contain API keys, tenant IDs, secrets — review before committing,
   and read the preview before anyone says yes to sending.
5. **Filing "the way I'd design it" as a bug.** Design disagreements
   are `--kind=design`, not `--kind=bug`. Both are welcome; the
   classification helps prioritization.

## References

- `FEEDBACK.md` at the pack root — the running list itself.
- `kindgi feedback submit --help`, `status --help` and `withdraw --help`.
