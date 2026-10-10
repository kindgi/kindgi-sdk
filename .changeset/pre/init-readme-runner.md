---
"@kindgi/cli": patch
---

A new pack's README runs the same commands `kindgi init` prints. The TypeScript templates' README said `pnpm install` and `pnpm typecheck` whatever the machine had, then a bare `kindgi dev`, which isn't on the PATH from a project install. Now its install, typecheck and every `kindgi` command use the runner the Next steps use: `pnpm exec kindgi` with pnpm, `npx --no kindgi` without it. A Python pack's README uses `uv run kindgi` with the PyPI CLI, else the published CLI through npx. The note that the SDK "is not yet published to npm" is gone: `kindgi init` pins the published version.
