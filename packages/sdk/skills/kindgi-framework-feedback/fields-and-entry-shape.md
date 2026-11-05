# An entry: the fields to fill, and its shape

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
