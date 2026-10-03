---
"@kindgi/cli": patch
---

Fixes for adding Kindgi to an existing app, and for `kindgi dev` output:
- **`pnpm install` works right after `kindgi init`** in a pnpm app. pnpm 11+ stopped the first install with `ERR_PNPM_IGNORED_BUILDS` for esbuild, which `@kindgi/cli` uses to bundle the pack. `init` now sets `allowBuilds.esbuild: true` in the `pnpm-workspace.yaml` pnpm reads (the workspace root's, or a new one in the app), as a new pack's template already does. It keeps the file's other keys and comments, and replaces pnpm's `set this to true or false` placeholder. An explicit `esbuild: false` is left alone, with a warning.
- **`init` adds `zod`** (`^4.0.0`, the new-pack range) to an existing app, since every tool's schemas use it. An app's own zod is kept; if it is older than zod 4, `init` says so.
- **Ctrl+C on `kindgi dev` prints one line**, `Stopping kindgi dev... stopped.`, not the startup banner and a JSON summary. The JSON summary now goes to stdout only with `--json` or `--raw`, and reports an empty pack as `ok`, not as an indexer error.
- **An empty pack says so at startup.** The startup output says there are no primitives yet and where to add the first one, and shows an indexer error at startup instead of at exit.
- **`--table` works** for `runs list`, `tools list` and `providers list`. When there is a next page, its `--cursor` goes to stderr.
- **The sample pack type-checks under pnpm.** `tsc --noEmit` failed with TS2742 on the sample guardrail. Its inline check is now typed with `DefinedCheck` from `@kindgi/sdk/define`.
