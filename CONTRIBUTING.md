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
  A pull request's text also leaves out internal tracking references
  (ticket and step ids, process rule numbers, release batch names,
  working session names), and
  its commits are public too: the commit-msg hook
  (`scripts/hooks/commit-msg`, installed by `pnpm install`) refuses such
  a message before the commit exists, while rewording is still easy. A
  real term that looks like one goes in `ALLOWED_TERMS`
  (`scripts/text-scan.mjs`), with why.
  Both say where a name is, never which; the list is kept hashed
  (`scripts/forbidden-names.json`, generated outside this repository).
  The pre-push hook (`scripts/hooks/pre-push`) also runs a local check
  when the clone names one (`git config kindgi.prePushCheck <program>`),
  and does nothing otherwise.

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

The JVM SDKs (`sdks/java`) ship with that version too, spelled as npm
spells it (Maven orders it the same way; `VersionOrderTest` in
`sdks/java/codegen` holds it to that). `pnpm run version-packages` runs
`scripts/sync-jvm-version.mjs --release`, which sets the root pom's own
version and each module's parent version (no other `<version>`), the
Scala module's `version.sbt` once it exists, and turns
`sdks/java/CHANGELOG.md`'s **Unreleased** heading into the version. A
branch whose poms lag main runs the script without `--release`: that
moves the versions and stamps nothing. CI fails when they differ
(`pnpm run check:jvm-version`).

1. Every user-visible change adds a changeset: `pnpm changeset`. Before
   1.0, and while release candidates are out, it's a `patch`: one
   `minor` moves every package to the next minor, which no installed
   project reaches. A changeset that means to move the release says so
   in its body: `Release-decision: <the version, who decided, and
   when>`, naming a role (the maintainers), never a person, since the
   body becomes the changelog entry (`pnpm run check:changeset-bumps`,
   in CI). Changesets don't reach the JVM SDKs (`sdks/java`): a
   user-visible change there adds its line under **Unreleased** in
   `sdks/java/CHANGELOG.md`, in the same pull request.
2. Merging to `main` updates the "Version Packages" pull request
   (opened by the org's release GitHub App, so CI runs on it like any
   other pull request).
3. Merging that pull request bumps versions and changelogs. Run
   `pnpm run ci:local` on its branch first, so the docs tutorials pass
   against the release.
4. Publishing is a manual, approved run of the **Release** workflow
   (npm trusted publishing with provenance, and PyPI trusted publishing
   with attestations — no tokens). The JVM SDKs go to Maven Central first,
   and npm waits for them: the CLI scaffolds Java and Scala packs on
   kindgi-pack at its own version.

### Maven Central

Central takes signed artifacts through the Central Portal, and a version
it has is permanent: it can't be changed or deleted. The Release
workflow's `publish-maven` job, in the `maven-publish` environment
(required reviewer):

1. Maven (`./mvnw -P release deploy`) and sbt (`sbt +publishSigned`) build,
   test, sign and stage the artifacts on disk: every jar with its sources
   and javadoc jars, every file with its `.asc`.
2. `scripts/check-jars.mjs` checks those files: the artifacts we publish
   and no others, their version, the pom metadata Central requires, each
   pom's runtime dependencies against its list, classes only under
   `com/kindgi/` and no test code, the LICENSE and NOTICE, and no forbidden
   name in any class, source or page. The Java and Scala workflows run it on
   every pull request, on an unsigned staging.
3. `scripts/central-bundle.mjs` bundles the same files, verifying every
   signature against the release key's fingerprint, and uploads them as one
   deployment, so a version's Java and Scala artifacts publish together or
   not at all. A dry run has the Portal validate the deployment and then
   drops it; nothing is published. A version Central already has is
   skipped.
4. Before npm publishes, its job waits until Central serves every JVM
   artifact at the CLI's version (`central-bundle.mjs on-central`), so npm
   never gets a CLI whose kindgi-pack doesn't resolve. A release that
   skipped Maven stops there.

The environment holds the Portal user token (`MAVEN_CENTRAL_USERNAME`,
`MAVEN_CENTRAL_PASSWORD`), the signing key (`MAVEN_GPG_PRIVATE_KEY`,
`MAVEN_GPG_PASSPHRASE`) and the key's public fingerprint (the variable
`MAVEN_GPG_FINGERPRINT`). The key is imported into a keyring of the job's
own and deleted at its end. A new module is published only once it's listed
in `check-jars.mjs`'s `ARTIFACTS`, with its runtime dependencies.

To stage and check locally (a JDK 17 and sbt): `./mvnw -P release
-Dgpg.skip=true deploy` in `sdks/java`, `sbt +publish` in `sdks/scala`, then
`node scripts/check-jars.mjs sdks/java/target/central-staging
sdks/scala/target/sona-staging`.

### Release candidates

A release can go out first as release candidates, `X.Y.Z-rc.N`, that no
one gets without asking for them by version:

- **npm:** they publish under the dist-tag `next`, never `latest`
  (`scripts/release-dist-tag.mjs`), and the Release workflow checks that
  `latest` is still a release afterwards.
- **PyPI:** they're `X.Y.ZrcN`, which pip and uv install only when asked
  for by version.
- **Maven Central:** they're `X.Y.Z-rc.N`, published like a release
  (Central has no tags). A build gets one only by naming it, or through a
  version range: Maven doesn't keep pre-releases out of ranges. They stay
  on Central: an rc CLI's `kindgi init --template=java` and `kindgi build`
  need its kindgi-pack there.
- **The public docs** come from releases only.
- **An rc CLI keeps its set together:** `kindgi init` pins the rc
  packages, a Python pack gets `kindgi>=X.Y.ZrcN,<…`, and its hints name
  `@kindgi/cli@X.Y.Z-rc.N`.

The steps:

1. **Start:** `pnpm changeset pre enter rc` in a pull request
   (`.changeset/pre.json`). From then on, the "Version Packages" pull
   request versions `X.Y.Z-rc.0`, then `rc.1`, and so on. Publish each
   as above. While candidates are out, every changeset is a `patch`: a
   `minor` would move the release itself.
2. **Release:** `pnpm changeset pre exit` in a pull request. The next
   "Version Packages" pull request versions `X.Y.Z`, its changelog
   gathering every rc's changesets, and that publishes under `latest`.

The runtime image follows the same versions: the runtime's release takes
`X.Y.Z-rc.N`, and never moves `preview` for one.
