---
"@kindgi/handler-runtime": patch
---

`pack-service-main` and `managed-run-worker` run when started through a symlinked path (`node node_modules/@kindgi/handler-runtime/dist/pack-service/main.js` in a pnpm install). They compared `import.meta.url` with `process.argv[1]` as given, so through a symlink they exited 0 without serving.
