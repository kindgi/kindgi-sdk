---
"@kindgi/cli": patch
---

**`--quiet` prints errors and warnings only.** The global flag's help now reads "Print errors and warnings only: the exit code reports the result."
- **`kindgi deploy`** leaves out its own progress lines. It still prints:
  - a refused deployment's error, and the error of a deploy that stops before it is sent;
  - a secret sync that fails. The exit code stays 0, since the deployment is in place. A sync that never reaches the server now also says the deployment landed and how to sync again;
  - a pack service env that refuses the deploy: its plan, then the error that points to it;
  - its warnings: secret-shaped keys in `.env.<env>`, `--allow-missing-env`, the plan's own warnings, and an unsigned envelope under `--dry-run`.
- **`kindgi build`** and deploy's inline build still print their warnings: a skipped integrity gate or image pull, a pull that failed, an unsigned envelope, a skipped `patch-package` script, no build secrets on the build service, the indexer's warnings, and computed imports under `image.keep`.
- **`kindgi dev`** still prints its warnings: the dev sandbox off or unavailable, a port in use, a provider not registered, and the rest. Its log level under `--quiet` is `warn`, not `error`.
- **`kindgi exports create`** prints only a kind that failed, and how to finish an export that stopped or has kinds that failed. Its summary is left out.
- The CLI pin's warning and a rate limit's wait still show, as before.
