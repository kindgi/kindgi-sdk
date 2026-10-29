# Editing FEEDBACK.md directly

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
