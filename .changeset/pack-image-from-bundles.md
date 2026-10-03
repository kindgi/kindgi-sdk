---
"@kindgi/handler-runtime": minor
"@kindgi/cli": minor
---

A TypeScript pack image that works: it runs the pack's bundles, installs the app the way the app does, and `kindgi build --local` builds it with this machine's Docker.

`@kindgi/handler-runtime`:
- `runIndexer({ bundleMap, moduleRoot })` indexes a build. The map's source paths are the file list, classified by the discovery patterns, so the source tree needn't be there. Each file is imported from its bundle, and the index records the source path. `kindgi-index` takes `--bundle-map` and `--module-root`.
- `kindgi-index-main`: the indexer as a process entry. Before, the image's indexer stage loaded `kindgi-index` and exited without writing an index.
- The pack service's `--bundle-map`: the modules the index names load from their bundles.

`@kindgi/cli`, `kindgi build`:
- **Bundles:**
  - the pack's code is bundled, and its installed dependencies stay external, imported by name from the image's `node_modules`;
  - the indexer and the pack service are self-contained bundles;
  - every bundle is `.mjs` with sourcemaps, plus `dist/bundle-map.json` and the bundled `kindgi.config`;
  - the local index runs the same bundled indexer over the same bundles as the image, so the integrity gate compares like with like.
- **Install:** the app's own package manager from its own lockfile, frozen with scripts off, then the build scripts the app allows, then a prune to production. pnpm and yarn come through corepack and the `packageManager` field. A pack in a workspace member sits at its own path.
  - `.npmrc` and `.yarnrc*` are build secrets, never in the context.
  - A dependency linked from outside the project is refused, with what to do instead.
  - The synthesized `package.json` is gone.
- **Base image:** `node:22` or `node:24-bookworm-slim`, pinned by image index digest, picked from `engines.node` (`scripts/refresh-node-digests.mjs`).
- **The Containerfile:** tini, `USER node`, `HEALTHCHECK`, `EXPOSE 8080`, `NODE_ENV=production`.
- **The context:** the install's files, the bundles and `bundle.include`. The pack's source never ships.
- **`--local`:** `docker buildx build --load` into the local image store as `kindgi-pack/<packId>:<artifactVersion>`, with the same integrity gate. No build service, no signing.
