---
"@kindgi/cli": patch
---

The CLI's printed commands name a package manager this machine has. A project from `kindgi init` declares pnpm, but on a machine without pnpm (after `npm install`) the CLI used to print `pnpm install` and `pnpm exec kindgi …`. Now, when the declared manager (pnpm, yarn or bun) doesn't run here (`<pm> --version`), the CLI uses npm: `npm install` and `npx --no kindgi …`. This applies to `init`'s next steps and its dependency specs, `kindgi dev`'s banner, the `providers` hints, `.mcp.json`'s launch command, and `kindgi doctor`'s fixes. doctor's install fix also says which manager the project names. `usablePackageManager` is the shared check, probed once per manager per run.
