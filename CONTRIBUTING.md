# Contributing to the Kindgi SDK

**Status:** the SDK is in preview and we are not accepting external
contributions yet. Issues and security reports are welcome
(see [SECURITY.md](./SECURITY.md) for vulnerabilities). This document
describes how the repository works for maintainers.

## Setup

Requires Node.js 22.12+ and pnpm (the version pinned in `package.json`'s
`packageManager` field; `corepack enable` picks it up).

```sh
pnpm install
pnpm run ci        # lint, border check, spec validation, build, typecheck, test, publish checks
```

GitHub runs CI on every pull request that isn't a draft: lint and
specs, the build, typecheck, tests and publish checks, the docs site and
its samples, and the Python SDK on 3.11 and 3.13. Merging requires them.

One step runs only on your machine: the docs tutorials, which start
`kindgi dev` with the private runtime image (`pnpm run docs:tutorials`).
`pnpm run ci:local` runs all of CI, the tutorials included, on the clean,
pushed commit. It needs pnpm, uv and Docker.

## With your coding agent

Changes here are made by coding agents and supervised by people: the agent
does the work, and you read it before it's submitted.
[`.claude/skills/kindgi-contributing/SKILL.md`](./.claude/skills/kindgi-contributing/SKILL.md)
tells your agent how. Claude Code loads it by itself in a clone, and
[`AGENTS.md`](./AGENTS.md) points other agents to it. It covers:
- where a docs page's source is;
- the checks to run for what changed;
- the pull request's format.

Every pull request carries:
- the agent's `Co-Authored-By` trailer on its commits;
- a `## Checks` list of the checks it ran, with their results;
- a `Supervised-by:` line with your own name and email.

A check on the pull request asks for any of them that's missing.

## Rules

- **License headers.** Every source file starts with:

  ```ts
  // SPDX-License-Identifier: Apache-2.0
  // Copyright (C) 2026 Kindgi Inc.
  ```

  The pre-commit hook (`scripts/hooks/pre-commit`, installed by
  `pnpm install`) and `pnpm run check:headers` (CI) enforce this.
- **Self-contained packages.** Packages depend only on other packages in
  this repository and on third-party libraries. Runtime capabilities are
  expressed as binding interfaces that the host supplies — never as a
  dependency on a runtime implementation. `pnpm run check:border`
  enforces this.
- **HTTP routes.** Adding or changing a route in `@kindgi/api` follows
  [docs/ADDING-A-ROUTE.md](./docs/ADDING-A-ROUTE.md).
- **Specs.** `@kindgi/specs` (`packages/specs/schemas/`) holds the
  canonical wire contracts. Change a schema there first, then every
  package that bundles a copy (drift tests enforce equality);
  `pnpm run spec:validate` checks the whole set.
- **Public text.** The repository's files, and a pull request's title,
  description and commit messages (the squash commit's message is the
  title and description), leave out internal process notes: development-
  phase ids, scratch paths, unresolved placeholders. They also leave out a few names the
  project doesn't use in public, the runtime's internal name among them:
  describe things by their role ("the runtime", "the runtime's release").
  `pnpm run check:refs` (CI) checks files; the **PR text** check checks a
  pull request's own text, and runs again when you edit the description.
  Both say where a name is, never which; the list is kept hashed
  (`scripts/forbidden-names.json`, generated outside this repository).

## Releases

All `@kindgi/*` packages share one version (Changesets fixed group), and
the Python SDK (`kindgi` on PyPI, `sdks/python`) ships with that same
version. Nobody sets the Python version by hand:
`pnpm run version-packages` runs `scripts/sync-python-version.mjs` after
`changeset version`, which writes the new version to `pyproject.toml` and
re-locks `uv.lock` (it needs uv). CI fails when they differ
(`pnpm run check:python-version`), and so do both publish jobs. A
prerelease is `-alpha.N`, `-beta.N` or `-rc.N` (`aN`, `bN`, `rcN` on
PyPI); the script refuses any other.

1. Every user-visible change adds a changeset: `pnpm changeset`.
2. Merging to `main` updates the "Version Packages" pull request
   (opened by the org's release GitHub App, so CI runs on it like any
   other pull request).
3. Merging that pull request bumps versions and changelogs. Run
   `pnpm run ci:local` on its branch first, so the docs tutorials pass
   against the release.
4. Publishing is a manual, approved run of the **Release** workflow
   (npm trusted publishing with provenance, and PyPI trusted publishing
   with attestations — no tokens).

### Release candidates

A release can go out first as release candidates, `X.Y.Z-rc.N`, that no
one gets without asking for them by version:

- **npm:** they publish under the dist-tag `next`, never `latest`
  (`scripts/release-dist-tag.mjs`), and the Release workflow checks that
  `latest` is still a release afterwards.
- **PyPI:** they're `X.Y.ZrcN`, which pip and uv install only when asked
  for by version.
- **The public docs** come from releases only.
- **An rc CLI keeps its set together:** `kindgi init` pins the rc
  packages, a Python pack gets `kindgi>=X.Y.ZrcN,<…`, and its hints name
  `@kindgi/cli@X.Y.Z-rc.N`.

The steps:

1. **Start:** `pnpm changeset pre enter rc` in a pull request
   (`.changeset/pre.json`). From then on, the "Version Packages" pull
   request versions `X.Y.Z-rc.0`, then `rc.1`, and so on. Publish each
   as above.
2. **Release:** `pnpm changeset pre exit` in a pull request. The next
   "Version Packages" pull request versions `X.Y.Z`, its changelog
   gathering every rc's changesets, and that publishes under `latest`.

The runtime image follows the same versions: the runtime's release takes
`X.Y.Z-rc.N`, and never moves `preview` for one.
