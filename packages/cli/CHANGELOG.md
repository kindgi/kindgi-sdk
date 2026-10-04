# @kindgi/cli

## 0.1.1

### Patch Changes

- 799aaaa: **`kindgi auth registry` logs Docker in to the runtime image's registry.** The Kindgi runtime image `kindgi dev` runs is in private preview. With the pull credentials you receive, `kindgi auth registry --username <robot name>` asks for the token without echoing it (or reads it from stdin with `--password-stdin`), runs `docker login` with the token on its stdin, then checks that Docker can pull the exact image this CLI runs (with `docker buildx imagetools inspect`, or `docker manifest inspect` by digest where buildx isn't installed). Kindgi stores nothing: the credential lives in Docker's own credential store. `--check` only checks access, and a failure says whether it's access (request it at contact@kindgi.com) or the image or the network. When a pull is refused, `kindgi dev` now points to `kindgi auth registry`.
  
  **Ctrl+C at a hidden prompt cancels.** At the value prompt of `kindgi secrets set` and `rotate`, Ctrl+C (or Ctrl+D) ended the CLI silently with exit code 0. It now prints `Cancelled.` and exits 1, like the other prompts.
- a3070fa: Fixes for adding Kindgi to an existing app, and for `kindgi dev` output:
  - **`pnpm install` works right after `kindgi init`** in a pnpm app. pnpm 11+ stopped the first install with `ERR_PNPM_IGNORED_BUILDS` for esbuild, which `@kindgi/cli` uses to bundle the pack. `init` now records a decision for esbuild's install script, `allowBuilds.esbuild: false`, in the `pnpm-workspace.yaml` pnpm reads (the workspace root's, or a new one in the app). esbuild works without the script: its native binary comes from its `@esbuild/<platform>` package. `init` keeps the file's other keys and comments, replaces pnpm's `set this to true or false` placeholder, and keeps a decision the app already has (`true` or `false`). New packs' templates also switch from `true` to `false`.
  - **`init` adds `zod`** (`^4.0.0`, the new-pack range) to an existing app, since every tool's schemas use it. An app's own zod is kept; if it is older than zod 4, `init` says so.
  - **Ctrl+C on `kindgi dev` prints one line**, `Stopping kindgi dev... stopped.`, not the startup banner and a JSON summary. The JSON summary now goes to stdout only with `--json` or `--raw`, and reports an empty pack as `ok`, not as an indexer error.
  - **An empty pack says so at startup.** The startup output says there are no primitives yet and where to add the first one, and shows an indexer error at startup instead of at exit.
  - **`--table` works** for `runs list`, `tools list` and `providers list`. When there is a next page, its `--cursor` goes to stderr.
  - **The sample pack type-checks under pnpm.** `tsc --noEmit` failed with TS2742 on the sample guardrail. Its inline check is now typed with `DefinedCheck` from `@kindgi/sdk/define`.
- ca66617: `kindgi runs start --no-wait` describes what it does: an agent run returns as soon as it exists, like a flow run (follow it with `kindgi runs stream` or `kindgi runs get`). The `--path` help of `kindgi dev` and `kindgi test` names `kindgi.config.mts` too.
- e184714: **A new pack gets its `.gitignore` again.** `npx @kindgi/cli init` wrote no `.gitignore`: npm renames a package's `.gitignore` to `.npmignore` when it installs it, so the templates' file never reached the new pack, and `.env` (model keys) and `.kindgirc.json` (the dev token) weren't ignored by git. The templates now store it as `gitignore`, and `init` writes it as `.gitignore`. If you created a pack with 0.1.0, add a `.gitignore` with at least `.env`, `.env.local`, `.kindgirc.json` and `.kindgi/`. Adding Kindgi to an existing app was not affected.
- 811d030: **`kindgi dev` starts its Postgres without `docker compose`.** On a Docker engine without the compose plugin (common on a bare Linux engine), `kindgi dev` no longer stops and asks for `KINDGI_DATABASE_URL`: it starts the bundled Postgres with plain `docker`, and says so (`Postgres: started with docker (docker compose isn't available)`).
  - **The same Postgres either way:** the image, settings, healthcheck and random host port the bundled compose file defines, and the same container (`kindgi-dev_postgres`), volume (`kindgi-dev_postgres-data`) and network (`kindgi-dev`), so the data is shared whichever way it was started. What plain `docker` creates carries the `kindgi-dev` compose project's labels, so once compose is installed, `kindgi dev` and `docker compose -p kindgi-dev down -v` take it as their own.
  - **An existing container is reused as it is**, started if it's stopped, never recreated or removed. `--recreate-services` needs compose: without it, `kindgi dev` says the container was reused and how to recreate it by hand. `--reset` behaves as before: it starts one pack fresh and leaves the shared Postgres alone.
  - **The bundled Postgres listens on `127.0.0.1` only** (a random port), in both ways of starting it: its password is a fixed dev one, so it must not be reachable from the LAN. The runtime container still reaches it, through `host.docker.internal` on Docker Desktop and directly with Linux host networking. A `kindgi-dev_postgres` an earlier CLI started keeps its old binding (every address) until it's recreated: `kindgi dev --recreate-services` with compose, or `docker rm -f kindgi-dev_postgres` without it (the data stays in its volume), then `kindgi dev`.
  - **Without Docker,** the error names the two options: install Docker, or pass `--database-url` (or set `KINDGI_DATABASE_URL`) for your own Postgres 16 with pgvector.
- 3699f29: **`kindgi dev` warns about an import `kindgi build` would refuse:** a package the pack imports that `package.json` lists only in `devDependencies`. It loads on your machine, but a deployed pack installs production dependencies only, so it's missing there. The warning names the package and the files importing it, at startup and when a save adds one, once per package; after you move it to `dependencies`, the next reload says it's resolved. It checks what a pack image would load from `node_modules`, including what `kindgi.config.ts` imports. `--json` and `--raw` list them as `devOnlyImports`. Python packs aren't checked.
- faf19ec: A pack image never runs the app's own install scripts.
  
  - **The bug:** `kindgi build` installs the app's dependencies with scripts off, then rebuilds so the dependencies the app allows can build. The rebuild also ran the app's own pending scripts: pnpm and npm treat the project itself as pending. So a `postinstall: prisma generate` or a `prepare: husky` ran in the image and failed the build, since the image holds no schema and no `.git`.
  - **The fix:** the build context's copies of the app's project manifests (the root's, each workspace member's, the pack's) leave out their install lifecycle scripts: `preinstall`, `install`, `postinstall`, `prepare` and its pre/post, `prepublish`, `dependencies`. Every other field and script stays. The lockfile, the dependencies' own scripts and the allowlist are untouched. What the image needs from such a script comes from a build extension: `prisma()` runs `prisma generate`.
  - **`kindgi build` says what it left out:** "The app's own install scripts don't run in the image: postinstall (`prisma generate`), prepare (`husky`)".
  - **A skipped script that runs `patch-package` gets a warning:** its patches wouldn't be applied in the image. To apply them, add a build step: `defineBuildExtension({ name: 'patch-package', contextFiles: [<the patch files>], postInstall: [{ bin: 'patch-package' }] })`. Or, with pnpm, use `pnpm patch`, which the install applies itself.
- 319a134: A pack module that wouldn't load in the image now fails the build, saying why, not as a vague integrity-gate mismatch later.
  
  - **`@kindgi/cli`:**
    - `kindgi build` refuses a pack that imports a package its project lists only in `devDependencies`, before the image is built. The image keeps production dependencies only, so such an import loads locally but not in the image. The message names the package and says to move it to `dependencies`.
    - A Node pack's local index fails the build on file errors (a module that throws on import), as a Python pack's already did.
    - The image's indexer stage runs `kindgi-index --strict`.
  - **`@kindgi/handler-runtime`:** `kindgi-index --strict` exits 1 when a module fails to load, printing each file error. Before, the index was written without that module, and only the CLI's integrity gate noticed: "indexHash mismatch".
- 324aba4: **`POST /v1/runs/{runId}/resume` is not available in this release.** It now answers `422 run-resume-not-supported` and completes nothing. Every waitpoint a run can wait at belongs to an approval or to the runtime itself. A run waiting for an approval continues when a reviewer decides it, through `POST /v1/approvals/{approvalId}/complete` (`kindgi approvals complete`), which checks the reviewer and records the decision. `kindgi runs resume` says the same and is left out of `--help`.
- Updated dependencies [0fe5626]
- Updated dependencies [5ef3129]
- Updated dependencies [319a134]
- Updated dependencies [d00fc1b]
- Updated dependencies [d28e1fd]
- Updated dependencies [ca66617]
- Updated dependencies [bbe0bc9]
  - @kindgi/sdk@0.1.1
  - @kindgi/handler-runtime@0.1.1
  - @kindgi/env-schema@0.1.1
  - @kindgi/secrets-dotenv@0.1.1
  - @kindgi/client@0.1.1
  - @kindgi/crypto@0.1.1
  - @kindgi/dotenv-file@0.1.1
  - @kindgi/platform@0.1.1
  - @kindgi/types@0.1.1

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
