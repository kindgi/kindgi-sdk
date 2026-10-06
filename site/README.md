# Kindgi documentation site

The source of [docs.kindgi.com](https://docs.kindgi.com): Astro Starlight,
content in `src/content/docs/`. Private workspace package; never published.

```sh
pnpm run docs:dev     # from the repo root: a live preview at localhost:4321
pnpm run docs:build   # what CI runs: the build, its link check, search
```

## Where a page goes

| Section | Directory | A page here… |
|---|---|---|
| Start | `start/` | gets someone from nothing to a running pack |
| Tutorials | `tutorials/` | builds one real thing, every step run by CI |
| Guides | `guides/` | does one task, assuming the basics |
| Concepts | `concepts/` | explains how something works and why |
| Reference | `reference/` | lists everything, generated from the sources where one exists |
| Contributing | `contributing/` | is for people changing this repository |

## Rules

- **Links are relative** (`../guides/`, `introduction/`), never root-absolute
  (`/guides/`). Each release's docs are served under their own version
  (`/v0.2/…`), and a root-absolute link breaks there. The build checks every
  internal link under a version base and fails on one that doesn't resolve.
- **Docs ship with the change.** A PR that changes something public (an API
  route, an SDK export, a CLI command, a setting) updates the page that
  describes it.
- **Write for the reader's task.** Plain sentences, the example first, one
  idea per paragraph. Say what the reader does and what they get.
- **Nothing internal:** no private package names, no customer names, no internal
  codenames, no references to private documents.

## Versions

Every released minor line has its own docs, built from its newest
`@kindgi/sdk@X.Y.*` tag, so its pages, its generated reference and its code
are the same commit:

```
/            the latest release line (the only one search engines index)
/vX.Y/       every release line
/next/       the newest release candidate (`@kindgi/sdk@X.Y.Z-rc.N`) while
             it's newer than every release; gone once its release ships
/versions.json   what the version menu lists
```

```sh
pnpm run build && pnpm run docs:versions   # the public site, into site/dist-versions/
pnpm run build && pnpm run docs:preview    # this checkout, a private preview, into site/dist-preview/
```

Only releases are public: readers install a release, so the site describes
what they have. A release candidate is the one exception, under `/next/`: its
pages say so, link to the latest release, and aren't indexed. Each release line builds in a temporary worktree at its tag.
A page on an older line says so and links to the latest; the version menu
keeps you on the same page when the other version has it.

The preview is this checkout (usually `main`, merged but not released), for
checking before a release. Every page says it's a preview, search engines
don't index it, and it's deployed only behind a login
(`wrangler.preview.jsonc`), never to the public site. `KINDGI_DOCS_BASE` sets the base a single build is served under, and
`KINDGI_DOCS_REF` the git ref its links into the repository point at.
