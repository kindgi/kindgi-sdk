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

Every release has its own docs, built from its `@kindgi/sdk@X.Y.Z` tag, so
its pages, its generated reference and its code are the same commit:

```
/            the newest release (the only one search engines index)
/vX.Y.Z/     every release
/vX.Y/       redirects to its line's newest release, page for page (_redirects)
/next/       the newest release candidate (`@kindgi/sdk@X.Y.Z-rc.N`) while
             it's newer than every release; gone once its release ships
/versions.json   what the version menu lists, with each build's exact version
```

```sh
pnpm run build && pnpm run docs:versions   # the public site, into site/dist-versions/
pnpm run build && pnpm run docs:preview    # this checkout, a private preview, into site/dist-preview/
```

Only releases are public: readers install a release, so the site describes
what they have. A release candidate is the one exception, under `/next/`: its
pages say so, link to the latest release, and aren't indexed. Each release
builds in a temporary worktree at its tag. A page of an older release says so
and links to the latest, since a later release may have fixed what it says;
the version menu keeps you on the same page when the other version has it.

**Fixing a released version's docs.** A release's pages can be fixed after it
ships, without a new release: open a PR into its `release-docs/<version>`
branch (create the branch at the release's tag first: `git push origin
'@kindgi/sdk@0.1.4^{commit}:refs/heads/release-docs/0.1.4'`). The branch may
change only `site/`, and must describe that version's behaviour, not a later
one's. `docs:versions` builds a release from `origin/release-docs/<version>`
when it exists (fetch first), else from its tag, and fails if the branch
changes anything outside `site/` or doesn't start at the tag. The code and the
generated reference stay the tag's; `versions.json` and the redirects don't
change. Land the same fix on `main` too, so the next release has it.

The preview is this checkout (usually `main`, merged but not released), for
checking before a release. Every page says it's a preview, search engines
don't index it, and it's deployed only behind a login
(`wrangler.preview.jsonc`), never to the public site. `KINDGI_DOCS_BASE` sets the base a single build is served under, and
`KINDGI_DOCS_REF` the git ref its links into the repository point at.
