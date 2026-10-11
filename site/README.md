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
| Tutorials | `tutorials/` | builds one real thing: every step run by CI, or pinned to the release a person tested it with |
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

**Tutorials on their own schedule.** A tutorial a person has run on a
release opts out of the release snapshots with a pin in its frontmatter,
`tested: 0.1.6`. Once that release is out, `docs:versions` builds `/` with
every pinned tutorial from `origin/main` (fetch first) in place of the
release's own copy, and the releases' and `/next/`'s copies of those pages
redirect to `/tutorials/…`; a tutorial pinned to a newer release waits for it
(`scripts/tutorials-overlay.mjs`). So merge a pinned tutorial to `main` only
when it's ready to publish:

- its pin, and a line at the top saying which Kindgi it was tested with, and
  when;
- a "Changes" section at the bottom: each publish's date, the version it was
  tested with, and what changed;
- links into the docs at its pinned version (`/v0.1.6/guides/…`), and
  versions written out: `{{kindgi.version}}` would be the newest release's.

A pinned tutorial is built with the newest release's site, so it may use only
what that site has: Markdown, Starlight's asides and `<details>`, and the
components that release's site has. An import it can't resolve stops the
build, naming the page. A tutorial without a pin (the support-desk ones,
which CI runs against the code) is versioned like every other page. Each
publish is a docs deploy.

The preview is this checkout (usually `main`, merged but not released), for
checking before a release. Every page says it's a preview, search engines
don't index it, and it's deployed only behind a login
(`wrangler.preview.jsonc`), never to the public site. `KINDGI_DOCS_BASE` sets the base a single build is served under, and
`KINDGI_DOCS_REF` the git ref its links into the repository point at.

**Links and versions in hand-written pages.** Link into the repository as
`https://github.com/kindgi/kindgi-sdk/tree/main/…` (or `blob/main/…`): a
build for a release points those links at its tag, as the generated pages
do, and fails if a page still reads `main` another way (`raw/main`,
`raw.githubusercontent.com`). Edit links stay on `main`. `{{kindgi.version}}`
in a page becomes the version the build is for: the CLI's at that ref, which
the JVM SDKs share. It's filled in code blocks (before highlighting, so the
copy button gets it too) and in text; in MDX prose, put it in inline code,
since `{` starts an expression there. Runtime image tags aren't this version
(the runtime can ship a patch of its own), so write those out. check-samples
and run-tutorials fill it the same way (`scripts/versioned-pages.mjs`).
