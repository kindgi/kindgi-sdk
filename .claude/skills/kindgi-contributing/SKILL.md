---
name: kindgi-contributing
description: >
  Make a change to the Kindgi SDK repository (kindgi-sdk) the way its
  maintainers review it: a docs page, a skill, or SDK, CLI or Python code.
  Covers finding a docs page's source, the repository's rules, the checks to
  run for what changed, showing the change to the person who asked before
  submitting it, and the pull request's format (the agent's Co-Authored-By
  trailer, a "## Checks" list, the person's Supervised-by line). Load this
  when asked to improve or fix a page of docs.kindgi.com, to fix something in
  kindgi-sdk, or to open a pull request in this repository.
---

# Contributing to kindgi-sdk

**You do the work; a person supervises.** Every change here is made by a
coding agent and read by the person who asked for it before it's submitted.
A maintainer reviews it, and CI decides. Never submit a change the person
hasn't seen.

## 1. Find what to change

A docs suggestion names a page of docs.kindgi.com and what's wrong with it.

- **A hand-written page** lives at `site/src/content/docs/<path>.md` or
  `.mdx`, where `<path>` is the URL's path without the version
  (`https://docs.kindgi.com/v0.2/guides/runs/start-a-run/` →
  `site/src/content/docs/guides/runs/start-a-run.mdx`; a section's overview
  is its `index.md`).
- **A reference page is generated.** Change its source, never the page:

  | Pages | Source |
  |---|---|
  | `reference/cli/` | the command's definition in `packages/cli/src/commands/` |
  | `reference/api/` | `packages/api/openapi.json` (and its route, see `docs/ADDING-A-ROUTE.md`) |
  | `reference/typescript/` | the export's TSDoc comment |
  | `reference/python/` | the docstring in `sdks/python/src/kindgi/` |
  | `reference/env-vars/` | `packages/env-schema/src/schema.ts` |
  | `reference/packages/` | the package's `README.md` |
  | `reference/schemas/` | `packages/specs/schemas/` |
  | `contributing/` | `CONTRIBUTING.md` and `docs/*.md` |

- A suggestion about Kindgi's behaviour, not its docs (a bug, a confusing
  error), is an issue first: say so to the person rather than editing docs
  to match a bug.

## 2. Make the change

Read `CONTRIBUTING.md` for the repository's rules (license headers,
self-contained packages, routes, specs). For docs:

- **Match the page around it:** its words, its headings, its TypeScript and
  Python tabs. Plain words and short sentences.
- **Every command and output on a page is real.** Run what you show, and
  quote the output you got. Don't invent output.
- **Every code block runs as pasted, or isn't offered for copying.** A whole
  file starts with its path (`// tools/lookup/index.ts`, `# tools/lookup.py`)
  and `pnpm run docs:samples` compiles it in a fresh pack. If the file
  imports a library the pack doesn't have, the page shows the reader its
  install command (`uv add fastapi`, `pnpm add nanoid`), and the page's
  hidden `<!-- check-samples: … -->` comment (`{/* check-samples: … */}` in
  MDX) holds the same step as a ```` ```sh ```` block of `uv add` or
  `pnpm add` lines, so the check adds the library first. A shell command
  names only commands and flags the CLI has, and JSON parses. Part of a file
  is an excerpt: its fence says so (```` ```ts excerpt ````) and it starts
  with `// in <path>` (`# in <path>`). The page shows it without a copy
  button, and it isn't compiled, so make sure it's right.
- **Links between pages are relative** (`../start-a-run/`), so they work in
  every version of the site. Link the page that answers the point, not its
  section's overview.
- **No real company, customer or person names** in examples: use `acme`.

A skill (`packages/sdk/skills/<name>/`: its `SKILL.md` and the files beside
it) also needs the `version` in its `SKILL.md` bumped when any of its files
changes; CI checks it (`pnpm run check:skill-versions`). A change to a
package's behaviour or to a skill needs a changeset (`pnpm changeset`); a
change to docs pages only doesn't.

## 3. Run the checks for what changed

Set up once: Node 22+, `corepack enable`, `pnpm install`, `pnpm run build`
(uv too for Python).

| You changed | Run |
|---|---|
| A docs page | `pnpm run docs:build` (every page; fails on a broken link), and `pnpm run docs:samples` when the page has code |
| A skill | `pnpm run check:refs`, `pnpm --filter @kindgi/sdk test` |
| TypeScript code | `pnpm run lint`, `pnpm run check:headers`, `pnpm run check:border`, `pnpm run check:constructor-super`, and the package's tests (`pnpm --filter <package> test`) |
| Python code | in `sdks/python`: `uv run pytest`, `uv run ruff check src tests scripts`, `uv run pyright` |
| A public contract (a route, a schema, a CLI command) | also `pnpm run check:docs-ship`, which asks for the docs |

Fix what fails before going on. CI runs the full suite again on the pull
request. If you couldn't run a check here (no Docker, say), leave it out of
the list below and say so in "What and why".

## 4. Show the person, and wait

Before you commit, show the person who asked:

- the diff;
- the checks you ran, and their results.

Wait for their go. They supervise this change, and their name goes on the
pull request. Ask for the name and email they want on it; never guess them,
and never leave a placeholder.

## 5. Open the pull request

- **Work on a fork** (`gh repo fork kindgi/kindgi-sdk --clone`) unless the
  person maintains the repository. Use a branch named for the change
  (`docs/fix-start-a-run-example`).
- **Commit only your own changes:** `git add <each file you changed>`, never
  `git add -A`. The clone may hold other work.
- **Every commit you wrote carries your own trailer:**
  `Co-Authored-By: <your agent name> <email>`, as you usually sign commits.
- **The pull request's body has exactly this shape.** GitHub pre-fills a new
  pull request's body from `.github/pull_request_template.md` with these
  sections: fill them in rather than replace them.

  ```text
  ## What and why

  <What changed and why, in a few sentences. For a docs fix, the page's URL.>

  ## Checks

  - [x] `pnpm run docs:build`: 723 pages, no broken links
  - [x] `pnpm run docs:samples`: 113 file samples check

  Supervised-by: <the person's name> <their email>
  ```

  One `- [x]` line per check you ran, with its real result (the numbers
  above are only an example). No unticked `- [ ]` lines.

- Open it with `gh pr create`, or give the person the branch and the body to
  open it themselves.

## What happens next

A check reads the pull request: your `Co-Authored-By` trailer, the
`## Checks` list and the `Supervised-by` line. When one is missing, it says
which in a comment, and you fix the body or the commits. A maintainer
reviews the change, and CI runs the full suite before it can merge.
