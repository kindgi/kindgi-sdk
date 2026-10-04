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

## Releases

All `@kindgi/*` packages share one version (Changesets fixed group).

1. Every user-visible change adds a changeset: `pnpm changeset`.
2. Merging to `main` updates the "Version Packages" pull request
   (opened by the org's release GitHub App, so CI runs on it like any
   other pull request).
3. Merging that pull request bumps versions and changelogs. Run
   `pnpm run ci:local` on its branch first, so the docs tutorials pass
   against the release.
4. Publishing is a manual, approved run of the **Release** workflow
   (npm trusted publishing with provenance — no tokens).
