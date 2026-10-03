# @kindgi/cli

## 0.1.0

### Minor Changes

- aec851d: `kindgi build --local --push [<repository>]` publishes from your machine:
  - **builds** for the deployment's platform: `linux/amd64` by default, as Cloud Run runs; `--platform` overrides it;
  - **pushes** to the repository: `--push`'s value, else `environments.<env>.registry` + `/<packId>`;
  - **checks** the pushed image's index against the local one, by digest;
  - **signs** as the build service path does, and writes `deploy-envelope.json` for `kindgi deploy`.
  
  It uses your own Docker credentials for the registry; Kindgi holds none. A command-line option can now take an optional value (`--push`, or `--push=<repository>`).
- aec851d: `describeCommands()` and `describeGlobalFlags()`: the CLI described as data (every command with its usage, its flags and its subcommands, and the global flags), with no handlers. The CLI reference on the documentation site is generated from them.
- aec851d: `@kindgi/cli`, the `kindgi` command, now lives in this repository: create a pack (`kindgi init`), run it on your machine against the Kindgi runtime image (`kindgi dev`), build, sign and deploy it, and work with a running Kindgi API from the terminal. It depends only on `@kindgi/*` packages and joins the fixed version group. The README is rewritten for how the CLI works today.
- aec851d: Build extensions for a TypeScript pack image: `image` in `kindgi.config.*`, with `@kindgi/sdk/build`.
  
  ```ts
  import { prisma } from '@kindgi/sdk/build';
  
  export default {
    pack: { id: 'acme.app', version: '1.0.0' },
    image: {
      systemPackages: ['tesseract-ocr'],
      extensions: [prisma({ schema: 'prisma/schema.prisma', config: 'prisma.config.ts' })],
      buildEnv: { DATABASE_URL: 'postgresql://build-placeholder' },
    },
  };
  ```
  
  - **`@kindgi/handler-runtime/build-extensions`**, re-exported as **`@kindgi/sdk/build`**:
    - `ImageConfig` and `BuildExtension` (`contextFiles`, `systemPackages`, `postInstall` steps, `buildEnv`);
    - `prisma({ schema, config? })`: copies the schema in and runs `prisma generate` after the install, before the prune. An app's `postinstall` doesn't run in the image;
    - `defineBuildExtension()`.
  - **`kindgi build`** reads and checks `image`, naming any field that's wrong, then renders it:
    - system packages in the base stage;
    - `buildEnv` in the install stage only, never the final image;
    - each step after the install, through the app's package manager (`pnpm exec`, `npx --no`, `yarn`).
- aec851d: A TypeScript pack image that works: it runs the pack's bundles, installs the app the way the app does, and `kindgi build --local` builds it with this machine's Docker.
  
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

### Patch Changes

- 5fdc80b: Every flag says what it does: `kindgi <command> --help` lists the command's flags with a description, the global flags in `kindgi --help` come from the same definitions, and `describeCommands()` / `describeGlobalFlags()` carry the descriptions (the docs' CLI reference shows them). The help's config precedence now names `.kindgirc.json`. The README's `--template` row matches the templates (`minimal` is the folders, no examples).
- aec851d: Launch fixes:
  - **Unwired commands are hidden.** The commands this release doesn't wire (memory, artifacts, provenance, proposals, observations, tokens, capabilities, conversations, flows, and agents list/get/unregister/versions, tools publish) no longer appear in `--help` or the generated reference. Calling one still says it's not wired yet.
  - **`env list --reveal`** refuses unless stdout, where the values go, is a terminal. Before, `--reveal > file` typed in a terminal wrote the values unredacted.
  - **`auth whoami`** checks the token on an authenticated route (`/v1/identity/whoami`) and shows the identity. A wrong token now fails.
  - **`secrets`:** a version conflict suggests `--write-mode=add-version`; `--limit` and `--if-version` must be integers; no internal wording in the missing `--scope` error.
  - The `kindgi dev` banner's feedback hint uses `--body-stdin`, so a coding agent running it doesn't wait on `$EDITOR`.
  - The README matches: published packages, the private-preview runtime image, and only the wired commands.
- 56e3453: A Python pack has no npm project to install the CLI into, so its hints (`init`'s next steps, the `kindgi dev` banner, `providers`' secret hint) and the `.mcp.json` entries `kindgi mcp add` writes now run the published CLI through npx, within the running CLI's minor: `npx --yes @kindgi/cli@0.1 <command>`. Before, they said `kindgi …`, which fails without a global install. Node 22 is needed.
- be597c4: `kindgi dev` runs the Kindgi runtime 0.1.0 by default, pinned by digest (`quay.io/kindgi/runtime:0.1.0@sha256:…`). Docker doesn't re-pull a tag it already has, so a tag could leave you on an older runtime. When the pull is refused, the message says the image is in private preview and how to request access.
- aec851d: `kindgi --version` and `kindgi version` report the versions in the CLI's and the SDK's `package.json` (as `kindgi init` already did), not a constant that read `0.0.0`.
- aec851d: `kindgi build`, a pack image's install:
  - **Overrides' tarballs ship:** a `file:`/`link:` target that pnpm `overrides` (in `pnpm-workspace.yaml` or `package.json`), npm's nested `overrides`, or yarn's `resolutions` point at is in the build context. Before, a vendored package only an override named was missing in the image, and the install failed. One outside the project is refused, with what to do instead.
  - **Only the pack's project, in a pnpm workspace:** the image installs `--filter '{./<pack>}...'` (the pack's project and what it depends on), and prunes with the same filtered install plus `--prod`. `pnpm prune` ignores a filter and installs the whole workspace. npm and yarn still install the whole workspace.
  - **pnpm's metadata cache** is a BuildKit cache mount too, and `~/.cache` belongs to `node`. Otherwise corepack can't write its own cache beside the mount.
- aec851d: A pnpm pack image's rebuild reuses the packages it already downloaded.
  
  - **The bug:** the install stage's pnpm store was never the cache mount. BuildKit creates a mount's parent folders as root, so pnpm skipped `~/.local/share/pnpm` and kept its store in the layer. Every rebuild with a changed lockfile downloaded everything again.
  - **The fix:** the store is a cache mount at `/home/node/.cache/pnpm-store`, under the `~/.cache` the stage gives `node`. The stage names it for pnpm explicitly (`pnpm_config_store_dir` for pnpm 11, `npm_config_store_dir` before it), in the install stage only.
- aec851d: The Python SDK, `kindgi`, publishes to PyPI with the npm packages, at `0.1.0`.
  
  - **`kindgi init` for a Python pack, from a published CLI**, writes `kindgi` from PyPI within the CLI's own minor: `kindgi>=0.1,<0.2` for a 0.1 CLI. That covers the new template, an existing app's `pyproject.toml`, and the install line it prints, quoted for the shell. A CLI run from a Kindgi checkout keeps using the checkout's `sdks/python`.
  - **`check:publish`** fails when `sdks/python` and the npm packages don't share a major.minor.
  - **`release.yml`** publishes `kindgi` to PyPI on the same dispatch, in its own `pypi-publish` environment, with trusted publishing and attestations. A version PyPI already has is skipped.
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [1f81d37]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/client@0.1.0
  - @kindgi/sdk@0.1.0
  - @kindgi/env-schema@0.1.0
  - @kindgi/types@0.1.0
  - @kindgi/handler-runtime@0.1.0
  - @kindgi/dotenv-file@0.1.0
  - @kindgi/secrets-dotenv@0.1.0
  - @kindgi/crypto@0.1.0
  - @kindgi/platform@0.1.0
