# @kindgi/cli

The `kindgi` command: create a Kindgi pack, run it on your machine while you
write it, build and deploy it, and work with a running Kindgi API (runs,
agents, tools, providers, approvals, …) from the terminal.

## Install

The CLI is **project-local**: a project depends on `@kindgi/cli` as a
devDependency and runs the `kindgi` it pins, never a global install.
`kindgi init` adds it for you.

```sh
npx @kindgi/cli init            # in an existing app, or: init <pack-name>
pnpm install
pnpm exec kindgi dev            # npm: npx --no kindgi dev
```

Use the scoped name, `@kindgi/cli`: there is no unscoped `kindgi` package.

**Requirements:** Node 22.12 or later, and Docker for `kindgi dev` (Docker
Desktop, or a Docker engine on Linux). A Python pack needs Python and the
[`kindgi` Python SDK](../../sdks/python), and gets this CLI from PyPI as
`kindgi-cli`, with its own Node: `uv add --dev "kindgi-cli>=0.1,<0.2"`, then
`uv run kindgi <command>`.

## The pack lifecycle

| Command | What it does |
|---|---|
| [`kindgi init`](#kindgi-init) | Scaffold a pack, or add Kindgi to an existing app. |
| [`kindgi dev`](#kindgi-dev) | Run the Kindgi runtime as a container, with your pack's code on your machine, re-indexed on every save. |
| [`kindgi test`](#kindgi-test) | Run the pack's tests with its own vitest. |
| [`kindgi build`](#kindgi-build) | Bundle, build and sign a pack image; writes `deploy-envelope.json`. |
| [`kindgi deploy`](#kindgi-deploy) | Send the signed envelope to `POST /v1/deployments`. |
| [`kindgi env`](#kindgi-env) | Per-environment values, kept in env files next to the pack. |
| [`kindgi secrets`](#kindgi-secrets) | Per-environment secrets, through the API. |
| [`kindgi key`](#kindgi-key) | Ed25519 signing keys: local pairs under `~/.kindgi/keys/`, and the runtime's trust list. |
| [`kindgi skills`](#kindgi-skills) | Refresh the Claude Code skills in `.claude/skills/`. |
| [`kindgi mcp`](#kindgi-mcp) | MCP servers for your coding agent, in `.mcp.json`. |
| [`kindgi feedback`](#kindgi-feedback) | Note framework friction in the pack's `FEEDBACK.md`. |

The rest of the commands talk to a running Kindgi API: see
[API commands](#api-commands).

## Quick start

```sh
pnpm exec kindgi init my-pack --template=sample
cd my-pack && pnpm install
pnpm exec kindgi dev
```

Then, from another terminal in the pack directory (`kindgi dev` writes the
API URL and token to `.kindgirc.json` there, so every command run in the
pack talks to it):

```sh
pnpm exec kindgi runs start --agent=my-pack.echo-agent --input='{"userMessage":"hi"}'
pnpm exec kindgi runs start --flow=my-pack.echo-flow --input='{"name":"Ada"}'
pnpm exec kindgi runs start --flow=my-pack.echo-flow --input='{"name":"Ada"}' --dry-run
```

## `kindgi init`

```sh
kindgi init [<pack-name>] [--template=minimal|sample|python] [--path=<dir>]
            [--force] [--link-local] [--new-repo] [--pack-id=<id>]
```

Three modes:

- **`kindgi init <pack-name>`** scaffolds a new pack: the standard folders,
  a `kindgi.config.ts`, starter primitives, tests and a README. A pack that
  stands alone (no project around it) gets `"packageManager": "pnpm@<version>"`
  with the version `pnpm --version` gives there. `kindgi build`'s image, CI
  and teammates then install with that same pnpm. Inside an existing project,
  that project's own setup is left to govern.
- **`kindgi init`** in a directory with a `package.json` adds Kindgi to that
  app: a `kindgi.config.ts`, a `kindgi/` folder for the pack's primitives,
  the skills under `.claude/skills/`, and `.gitignore` entries. It adds
  `@kindgi/sdk`, `zod` (`^4.0.0`, unless the app has its own: one older than
  zod 4 is kept, with a warning) and `@kindgi/cli` to `package.json`. In a
  pnpm app it records a decision for esbuild's install script
  (`allowBuilds.esbuild: false`) in the `pnpm-workspace.yaml` pnpm reads,
  creating it if needed and keeping the rest of the file: pnpm 11+ won't
  install `@kindgi/cli` until that script has a decision, and esbuild works
  without it (its binary comes from its `@esbuild/<platform>` package). In an
  npm app the same decision goes in `package.json`'s `allowScripts`
  (`"esbuild": false`), without which npm 11 warns that the script isn't
  covered. A decision the app already has, `true` or `false`, is kept. A new
  pack's `package.json` has it too. It creates
  no env files: `kindgi dev` reads the app's own `.env` / `.env.local`.
  `--new-repo` scaffolds a separate pack inside the app instead.
- **`kindgi init`** in a directory with a `pyproject.toml` and no
  `package.json` (or `--template=python` where both are) adds a Python
  pack to that app, editing its `pyproject.toml` in place and checking each
  edit by parsing the file again:
  - the `[tool.kindgi]` tables: the pack id from `[project].name`
    (normalized; `--pack-id` overrides), discovery under `kindgi/`, and for
    a Poetry app `dev.python = ["poetry", "run", "python"]`;
  - `kindgi` in `[project].dependencies`. Where the dependencies can't be
    edited that way (Poetry 1, `dynamic`), it prints the command to run
    instead;
  - `[tool.uv] required-version`, unless the app sets its own.

  Plus `kindgi/{tools,guardrails,agents,flows}/`, the Python-pack skills and
  `.gitignore` entries. The next steps it prints follow the app's
  installer: uv, Poetry or pip.

A Node project gets `@kindgi/sdk` (a dependency) and `@kindgi/cli` (a
devDependency) at the running CLI's own version, or linked from a checkout
(`--link-local`); never `latest`.

| Flag | Purpose |
|---|---|
| `<pack-name>` | The pack id: lowercase kebab-case, optionally dot-namespaced (`my-pack`, `acme.legal-basics`). |
| `--template=<name>` | `minimal` (the default: the folders, no examples), `sample` (three tools, a guardrail, an agent and a flow), or `python` (the sample as a Python pack). |
| `--path=<dir>` | Where to scaffold. Default: `<pack-name>` under the current directory (for a dot-namespaced id, its last segment). |
| `--force` | Write into a non-empty directory. Default: refuse. |
| `--link-local` | Link `@kindgi/*` from the checkout the CLI runs from. |
| `--new-repo` | In an existing app: scaffold a separate pack rather than adding Kindgi to the app. |
| `--pack-id=<id>` | Adding to an app: the pack id, when the app's name doesn't make a valid one. |

### Skills

`init` copies the `@kindgi/sdk` skills into `.claude/skills/`, so a coding
agent working in the pack knows how to write tools, agents, guardrails,
flows and providers. A pack gets the skills written for its language: a
TypeScript pack the TypeScript ones, a Python pack the `kindgi-python-*`
ones, both the shared ones. `kindgi skills sync` refreshes them, and
`.claude/skills/.kindgi-manifest.json` records what was installed.

## `kindgi dev`

```sh
kindgi dev [--port <n>] [--database-url <url>] [--tenant <id>] [--dev-token <token>]
           [--no-watch] [--path <dir>] [--reset [--yes]] [--recreate-services]
           [--runtime-image <ref> | --runtime-url <url>]
```

One command runs the whole loop on your machine:

- **The Kindgi runtime runs as a container** (`docker run`), one per pack
  directory, with the pack directory mounted at `/pack`. Its API is
  published on `127.0.0.1` only.
- **Your pack's code runs on your machine**, in a local pack service: the
  same process a deployment runs, with your Node or Python, your
  `node_modules` or virtualenv, and your app's modules. The runtime calls it
  for every tool and guardrail check.
- **Postgres:** a bundled Postgres, started with `docker compose` when it's
  available and with plain `docker` otherwise (the `kindgi-dev` project, with
  the same container, volume and network either way, shared by every
  `kindgi dev` on the machine and left running), or the one you name with
  `--database-url` / `KINDGI_DATABASE_URL`. The bundled one is published on
  a random port on `127.0.0.1` only, since its password is a fixed dev one;
  the runtime container reaches it through `host.docker.internal` (Docker
  Desktop) or directly (Linux host networking). A `kindgi-dev_postgres`
  started by an earlier CLI keeps its old binding (every address) until
  it's recreated: `kindgi dev --recreate-services` with compose, or, without
  compose, `docker rm -f kindgi-dev_postgres` (its data stays in the volume)
  and run `kindgi dev` again.
- **A database per project, and per git worktree.** In the bundled Postgres,
  each project gets its own database, `kindgi_<project>`, with its own dev
  tenant and user. A linked git worktree gets `kindgi_<project>__<worktree>`,
  so branches on different Kindgi versions never share a schema. The project
  is named by `project` in the Kindgi config (`kindgi.config.ts`, or `project`
  under `[tool.kindgi]` in `pyproject.toml`), else by the git repository, the
  workspace root or the pack's folder. The boot log says which. A database
  belongs to the folder that made it: another folder whose project has the
  same name is refused until you give it its own `project`. Every pack of one
  project shares the database and the tenant. Each pack still has its own
  tools, its own pack service and its own env files: a flow in one pack
  can't call another pack's tools under `kindgi dev`. The shared `kindgi`
  database that earlier releases used is left as it is.
- **The pack is indexed and watched.** `kindgi dev` finds every tool,
  guardrail, agent and flow, and on each save re-indexes, rebuilds the code
  and restarts the pack service. The next request sees the new definitions;
  a run already in flight keeps the version it started with.

| Flag | Purpose |
|---|---|
| `--port=<n>` | The port the API is reached on, on `127.0.0.1`. Default `4000`, or the next free port when it's taken (another `kindgi dev`, say). A `--port` that's taken is refused. |
| `--database-url=<url>` | The Postgres to use. Falls back to `KINDGI_DATABASE_URL` (the shell's, then the env files'). Without either, the bundled Postgres. |
| `--tenant=<id>` | Pin the tenant. Default: the project's dev tenant in the bundled Postgres; with `--database-url`, the previous run's (from `.kindgirc.json`), else a new one. The pack's primitives and registered providers stay with it. |
| `--dev-token=<token>` | Pin the API token. Default: the previous run's, else a new one. Each flag overrides only its own value: `--dev-token` alone keeps the tenant. |
| `--path=<dir>` | The pack root. Default: the current directory. It must have a `kindgi.config.ts`, or a `pyproject.toml` with a `[tool.kindgi]` table. |
| `--no-watch` | Start, index once, and exit. For smoke tests and CI. |
| `--reset` | Start the project fresh: drops its database in the bundled Postgres (every pack's dev data in it: runs, approvals, providers, secrets stored there), after asking, and makes a new token. Without a terminal to ask on it refuses, unless `--yes`. A database you pass with `--database-url` is never dropped: only the token is new. (To wipe every project's dev data: `docker compose -p kindgi-dev down -v`; without compose, `docker rm -f kindgi-dev_postgres`, then `docker volume rm kindgi-dev_postgres-data`.) |
| `--yes` | With `--reset`: drop the project's database without asking (for scripts). |
| `--recreate-services` | Let `docker compose` recreate the bundled Postgres if its definition changed. By default an existing container is reused as it is, so no other `kindgi dev` loses its database. Without compose, an existing container is always reused, and `kindgi dev` says how to recreate it by hand. |
| `--runtime-image=<ref>` | The runtime image to run. Default: the one this CLI release was tested with. |
| `--runtime-url=<url>` | Use a runtime you run yourself instead of starting the container. Start it with the pack's `.kindgi/dev/runtime.env`. |

### The runtime container

- **Configuration:** everything the runtime is told is written to
  `.kindgi/dev/runtime.env` (mode `0600`) and passed with
  `docker run --env-file`. The runtime reads nothing else from your
  machine.
- **Your machine's `localhost`:** calls the runtime makes to `localhost` (your
  app's `run.finished` webhook, an MCP server, a model server you run
  locally) reach your machine. On Docker Desktop they go through
  `host.docker.internal`. On Linux the container shares the host's network
  and runs as your user, so files it writes into the pack stay yours.
- **Google Cloud credentials:** for Vertex AI models, your Application
  Default Credentials file (`GOOGLE_APPLICATION_CREDENTIALS`, else the one
  `gcloud auth application-default login` writes) is mounted read-only.
  Kindgi keeps no key files of its own.
- **The image:** the runtime image is pulled on first use. It is in
  private preview: request access at contact@kindgi.com, then log Docker in
  with the pull credentials you receive:
  `kindgi auth registry --username <robot name>` (see
  [The runtime image's registry](#the-runtime-images-registry)). `kindgi dev`
  says so when a pull is refused.

### Env files

`kindgi dev` runs as the `local` environment and reads the project's own env
files at the pack root: `.env`, then `.env.local` on top, parsed the way the
application beside the pack parses them (dotenv grammar, `${VAR}`
expansion). Nothing is copied: a key already in the app's `.env` is available
to the pack.

- **`KINDGI_*` names configure Kindgi itself** (e.g. `KINDGI_DATABASE_URL`).
  Precedence: flag > shell > env files.
- **Every other name belongs to the pack**: providers, tools and MCP servers
  resolve them as secrets. `KINDGI_*` names never resolve as secrets, so the
  app's own `DATABASE_URL` stays the app's.
- **Writes** (`kindgi secrets set`, `kindgi env set --env=local`) go to the
  highest-precedence file (`.env.local`), and every other line is kept.
  Kindgi never edits a lower file such as the app's `.env`.
- **Different files?** List them, lowest precedence first, and restart
  `kindgi dev`:

  ```ts
  export default {
    pack: { id: 'acme.app', version: '1.0.0' },
    dev: { envFiles: ['.env', '.env.development', '.env.local'] },
  };
  ```

The startup output names the files it found and how many names they give the
pack. A malformed line is reported as `file:line`, never its text.

**The names the pack's code reads.** Declare them in `kindgi.config.ts`:

```ts
export default {
  pack: { id: 'acme.app', version: '1.0.0' },
  env: { required: ['DATABASE_URL'], optional: ['LOG_LEVEL'] },
};
```

A required name the env files don't give gets a warning in `kindgi dev`, which
keeps serving. A deployed pack service isn't ready without it, and says which
names it lacks. A deployment injects exactly the declared names.

### Model providers

A tenant with no providers gets `dev-echo`, a fallback provider (scripted
replies, no key, no network) that answers only while no other provider fits.
Agent turns run before you register a model, and registering one takes over
with nothing to switch off:

```sh
kindgi providers register --preset=anthropic           # the key must be in the env files
kindgi providers register --preset=gemini --project=<gcp-project>
```

A turn the fallback answers carries a `fallback-provider` warning, which
`kindgi runs start` prints. `kindgi providers unregister dev-echo` removes it
for good.

A preset's models carry their own output limit (Gemini 3.8 Flash: 65,536
tokens, thinking included). `--max-output-tokens=<n>` registers them with a lower
or different cap.

**Declared in the config**, `kindgi dev` registers them itself. Each project
and git worktree has its own dev database, so this registers them in every
worktree, after `--reset`, and on a teammate's machine:

```ts
// kindgi.config.ts
export default {
  pack: { id: 'acme', version: '0.1.0' },
  providers: [
    { preset: 'anthropic' },                     // its key, ANTHROPIC_API_KEY, in the env files
    { preset: 'gemini', project: 'acme-gcp', models: ['gemini-3.8-flash'] },
    { spec: { /* a --spec body */ secret_ref: { name: 'QWEN_API_KEY' } } },
  ],
};
```

In `pyproject.toml`, each one is a `[[tool.kindgi.providers]]` table with
the same keys. A preset takes:
- `models`;
- `project`;
- `secret`: the key's name, in place of the preset's own;
- `maxOutputTokens`.

A `spec` is what `--spec` takes. A key is always a secret's name, resolved in
the env files. A `spec` with a credential in `adapter_config` is refused.

On each boot, `kindgi dev`:
- registers a declared provider the runtime doesn't have. If its key isn't in
  the env files, it skips that provider and says so in one line;
- re-registers a provider it registered whose declaration changed;
- unregisters a provider it registered that the config no longer declares;
- leaves alone any provider it didn't register (by hand, or by another pack of
  the project), and names the `kindgi providers unregister` that lets the
  config's version apply. It warns (⚠) when that provider's region or models
  differ from the config's. The runtime doesn't list a provider's adapter, its
  settings or its key's name, so a difference only there gets the plain line.

It records which providers it registered in `.kindgi/dev/providers.json`, per
database and tenant.

**Any OpenAI-compatible endpoint** — an open-source model you serve yourself
(vLLM, llama.cpp's `llama-server`, Ollama, LM Studio), OpenRouter, a LiteLLM
proxy — registers with `--spec`, naming its base URL in `adapter_config`:

```json
{
  "adapter_id": "@kindgi/adapter-model-openai-compat",
  "adapter_config": { "baseURL": "http://127.0.0.1:8000/v1" },
  "metadata": {
    "id": "qwen-local",
    "region": "unspecified",
    "models": [{ "name": "qwen3.5-4b", "contextWindow": 32768, "features": ["tool-use"],
                 "cost": { "promptUsdPer1kTokens": 0, "completionUsdPer1kTokens": 0 } }]
  }
}
```

`kindgi providers register --spec=@qwen.json`, then point an agent at it
(`preferred_provider="qwen-local"`). An endpoint that needs a key takes a
`secret_ref` (`{ "envName": "local", "name": "MY_KEY" }`), resolved on every
call. The model must call tools in the OpenAI format: serve it with tool
calling on (vLLM `--enable-auto-tool-choice --tool-call-parser <model's>`,
`llama-server --jinja`) and, for a thinking model such as Qwen, thinking off: on the server
(vLLM `--default-chat-template-kwargs '{"enable_thinking": false}'`, `llama-server --reasoning off`),
or, for a shared server you can't reconfigure, per request from the provider row:
`"extraBody.chat_template_kwargs.enable_thinking": false` in `adapter_config` (one flat key per
request field; dots nest).

### What you see

```
  ✓ Kindgi is up
  API        http://127.0.0.1:4000
  Console    http://127.0.0.1:4000/console/
  Tenant     c9a4…
  Token      kgi_bt_…
  Providers  dev-echo (fallback) — …
  Origins    …

  Try it (from another terminal, cd to the pack dir first):
    pnpm exec kindgi runs start --agent=my-pack.echo-agent --input='{"userMessage":"hi"}'
    pnpm exec kindgi runs stream <run-id>

  Watching /path/to/my-pack
  Ctrl+C to stop.
```

Progress and the runtime's own log lines (`[runtime] …`, `[pack] …`) go to
stderr. With `--json` or `--raw`, a JSON summary goes to stdout when it
exits, so `kindgi dev --no-watch --raw | jq` works.

### Watching

`kindgi dev` watches the pack's `discovery` patterns from `kindgi.config.ts`
(default `tools/`, `agents/`, `guardrails/`, `flows/`; an app with Kindgi
added watches `kindgi/`), and the env files. Only each pattern's fixed
directory is watched, never the whole app. The dev index lives at
`.kindgi/dev/index.json`.

- An empty pack is not an error: the output says where to add the first
  primitive. Its pack service starts with the first primitive; until then
  the runtime may warn once that the pack service isn't answering.
- A file that fails to index or build (a bad schema, a missing default
  export, a syntax error) is reported with its path and the error, and the
  previous code keeps serving until you fix it and save.
- A package the pack imports that `package.json` lists only in
  `devDependencies` gets a warning naming it and the files importing it, at
  startup and when a save adds one (once per package; the next reload after
  you fix it says so). It loads here, but a deployed pack installs
  production dependencies only, so `kindgi build` refuses it. `--json` lists
  them as `devOnlyImports`. A Python pack isn't checked.
- Deleting a primitive's folder removes it from the catalog.

### A Python pack

A pack whose config is the `[tool.kindgi]` table of its `pyproject.toml` is a
Python pack: its tools and guardrail checks are Python, its agents and flows
data. `kindgi dev` runs it the same way, with the pack's own interpreter:

- **The interpreter:** `dev.python` in `[tool.kindgi]` (a path, or a command
  such as `["uv", "run", "python"]`), else the pack's `.venv/bin/python`,
  else `python3`. It must import `kindgi` with the pack's environment, or
  `kindgi dev` stops and says how to install it.
- **Build:** every `.py` file under the pack root is compiled; a syntax
  error is reported as `file:line:col` and the previous code keeps serving.
- **Index and serve:** `python -m kindgi.pack index`, then
  `python -m kindgi.pack serve` in the pack service. The runtime can't tell
  it from a Node pack.
- **Watch:** any `.py` file under the pack root (shared modules included)
  and `pyproject.toml`.
- **The CLI:** a Python pack runs `kindgi-cli` from PyPI, the same CLI with
  its own Node, pinned in its dev group (`kindgi-cli>=0.1,<0.2`), so it needs
  no Node install. Run as `uv run kindgi <command>` (Poetry: `poetry run kindgi
  <command>`), which is what the startup hints and the `.mcp.json` entries
  `kindgi mcp add` writes say. The npm CLI still runs a Python pack:
  `npx --yes @kindgi/cli@0.1 <command>`.

### Stopping

Ctrl+C (or SIGTERM) stops the watchers, the pack service and the runtime
container, on one line: `Stopping kindgi dev... stopped.` A second Ctrl+C
forces the exit. The signal a package manager passes on with the first
doesn't count as a second: `npx` and `pnpm run` forward SIGINT, and
`pnpm exec` sends SIGTERM. A SIGTERM never forces the exit. Under
`pnpm exec`, pnpm exits at once, so the prompt comes back while
`kindgi dev` finishes stopping and prints `stopped.`. Closing the terminal
(SIGHUP) stops it the same way, the runtime container included, even
mid-stop. The bundled Postgres
keeps running for the next `kindgi dev`. The exit code is `0` after a clean
stop and `1` if startup failed.

## `kindgi test`

```sh
kindgi test [--watch] [--reporter <name>] [--path <dir>] [-- <vitest-args>...]
```

Runs the pack's tests with the pack's own vitest (the CLI bundles none, so the
pack chooses its vitest version). The templates include a `vitest.config.ts`
and a first test. `--watch` runs vitest in watch mode; everything after `--`
goes to vitest as is. The CLI refuses to run without a `vitest.config.*` at
the pack root, and uses `pnpm exec vitest` in a pnpm project, else
`npx --no-install vitest`.

## `kindgi build`

```sh
kindgi build [--local [--push [<repository>]] [--platform <os/arch>]] [--env <name>] [--endpoint <url>] [--target <t>] [--out <dir>]
             [--artifact-version <v>] [--published-at <iso>] [--tenant <id>]
             [--signing-key <path>] [--registry-push-creds <ref>]
             [--skip-integrity-gate] [--skip-image-pull] [--skip-sign] [--path <dir>]
```

Builds a signed pack image with a Kindgi build server, and writes
`deploy-envelope.json` for `kindgi deploy`:

1. **Config:** reads `kindgi.config.ts` and the `--env` block (default
   `staging`): the build server, the tenant and the signing key.
2. **Bundle:** bundles every primitive and the config with esbuild, each
   `.mjs` with a sourcemap. The pack's own code, and the app code it imports,
   is bundled; the app's installed dependencies stay external, imported by
   name from the image's `node_modules`. The pack service and the indexer are
   self-contained bundles. A Python pack ships its source and lockfile
   instead.
3. **Index:** runs the bundled indexer over the bundles locally, into
   `expected-index.json`, exactly as the image's indexer stage will.
4. **Containerfile and context:** writes a multi-stage `Containerfile`
   and the build context:
   - what the install reads: `package.json`, the lockfile, every workspace
     member's `package.json`, the workspace file, patches, and tarballs
     vendored in the project;
   - the bundles;
   - what `bundle.include` lists.

   The pack's source never ships. Env files, `.kindgirc.json`, private keys
   and anything under `.git/`, `.kindgi/` or `node_modules/` are refused: a
   build that would ship one fails and names it. `.npmrc` and `.yarnrc*` are
   read by the install as build secrets, never copied into the image.
5. **Build:** uploads the context (`pack.tgz`) to the build server and
   streams its log.
6. **Integrity gate:** the image's index must match the local one, byte for
   byte (`--skip-image-pull` compares hashes only, without pulling the image).
7. **Sign and write:** signs the image digest and index hash with your
   Ed25519 key and writes `.kindgi/build/deploy-envelope.json`.

**The image (a TypeScript pack):**
- **Base:** `node:22` or `node:24-bookworm-slim`, pinned by digest: the
  first whose Node satisfies the app's `engines.node`.
- **Install:** the app's dependencies, installed the way the app installs
  them, from its own lockfile, frozen. pnpm and yarn come through corepack
  and the `packageManager` field. A pnpm app with no `packageManager` gets the
  host's pnpm version (`pnpm --version`), the one that wrote the lockfile,
  never the newest. Build scripts are off during the install;
  then `rebuild` runs the ones the app allows, and the install is pruned to
  production dependencies.
- **A workspace:** with pnpm, only the pack's project and what it depends on
  are installed, not the rest of the workspace. npm and yarn install the
  whole workspace.
- **Layout:** the lockfile's folder is `/app`, and a pack inside a workspace
  member sits at its own path.
- **Runs:** the pack service, under tini, as `node`, on `$PORT` (8080).

A dependency linked from outside the project (`link:../…`, `file:/…`) can't be
installed in an image: vendor it as a tarball inside the project
(`file:vendor/<name>.tgz`) or install it from a registry.

**What the image needs beyond the install** goes in `image`, with
`@kindgi/sdk/build`:

```ts
import { prisma } from '@kindgi/sdk/build';

export default {
  pack: { id: 'acme.app', version: '1.0.0' },
  image: {
    systemPackages: ['tesseract-ocr'],                  // Debian packages
    extensions: [prisma({ schema: 'prisma/schema.prisma', config: 'prisma.config.ts' })],
    buildEnv: { DATABASE_URL: 'postgresql://build-placeholder' },
  },
};
```

- `systemPackages` are installed in the base image.
- `prisma()` copies the schema (and config) into the image and runs
  `prisma generate` after the install, before the prune. The app's own
  `postinstall` doesn't run in the image, because the install runs with
  scripts off.
- `buildEnv` holds non-secret placeholders for the build steps, and for the
  indexer, which imports the pack's modules. It's never in the final image.
- `defineBuildExtension()` makes an app's own extension from the same parts:
  `contextFiles`, `systemPackages`, `postInstall` steps (a package's bin, run
  through the app's package manager) and `buildEnv`.

**`--local`:** builds the image of a TypeScript or Python pack with this
machine's Docker (`docker buildx build --load`) into its image store, as
`kindgi-pack/<packId>:<artifactVersion>`, with the same integrity gate. There
is no build server, signature or envelope, and no tenant or signing key
needed. It prints a `docker run` line.

**`--local --push`:** publishes from this machine, for `kindgi deploy`:
1. builds the image for the deployment's platform: `linux/amd64` by default,
   which Cloud Run runs (on Apple silicon, under emulation); `--platform`
   overrides it;
2. pushes it to `<repository>:<artifactVersion>`. The repository is `--push`'s
   value, else `environments.<env>.registry` + `/<packId>`;
3. pulls it back by digest for the integrity gate;
4. signs it as the build service path does, and writes
   `.kindgi/build/deploy-envelope.json`.

It uses your own Docker credentials for the registry, for example
`gcloud auth configure-docker <region>-docker.pkg.dev` for Artifact Registry.
Kindgi holds none. It needs the env block's `tenantId` and `signingKey`, or
`--tenant` and `--signing-key`.

Files a tool reads at runtime, rather than imports, go in `bundle.include`:

```ts
export default {
  pack: { id: 'acme.app', version: '1.0.0' },
  bundle: { include: ['kindgi/data/**/*.json'] },
};
```

**A Python pack:** the image is `python:3.13-slim-bookworm` with `uv`, both pinned by
digest, and the pack's dependencies come from its lockfile (`uv.lock`, or a
Poetry app's `poetry.lock`; one is required). Debian packages the code needs
go in `[tool.kindgi.image] system-packages = ["tesseract-ocr"]`. The image's
uv version must be in the pack's `[tool.uv] required-version`; `kindgi
build` stops before building when it isn't.

**Reproducible:** the build pins `SOURCE_DATE_EPOCH=0`, the publish time
(`--published-at`, default the epoch) and the artifact version
(`--artifact-version`, default `YYYYMMDD.1`), and the base images by digest,
so the same inputs give the same image.

| Flag | Purpose |
|---|---|
| `--local` | Build with this machine's Docker instead of a build server: no signing and no envelope unless `--push`. |
| `--push[=<repository>]` | With `--local`: push the image, sign it, and write the envelope. Default repository: the env block's `registry` + `/<packId>`. |
| `--platform=<os/arch>` | The image's platform. Default: `linux/amd64` when pushing, else this machine's. |
| `--endpoint=<url>` | The build server. Default: the env block's `build`. |
| `--tenant=<id>` | The tenant the signature names. Default: the env block's `tenantId`, else `KINDGI_TENANT_ID`. |
| `--signing-key=<path>` | The Ed25519 private key (PEM). Default: the env block's `signingKey`. |
| `--skip-integrity-gate` | Sign without re-checking the image's index. Prints a warning. |
| `--skip-sign` | Write an unsigned envelope (for CI that signs elsewhere); `kindgi deploy` refuses it. |

## `kindgi deploy`

```sh
kindgi deploy [--env <name>] [--from-envelope <path>] [--endpoint <url>] [--token <bearer>]
              [--tenant <id>] [--idempotency-key <str>] [--dry-run] [--sync-secrets]
              [--allow-missing-env] [--path <dir>]   # plus kindgi build's flags, used when there is no envelope yet
```

Sends the signed envelope to `POST /v1/deployments` and prints the
deployment. The envelope is `--from-envelope`, else
`.kindgi/build/deploy-envelope.json`, else `kindgi deploy` runs
`kindgi build` first (`--build-endpoint` is the build server there, since
`--endpoint` is the API).

- **The API:** `--endpoint`, else the env block's `endpoint`, else
  `--url` / `KINDGI_API_URL`.
- **Idempotent:** the `Idempotency-Key` header is a hash of the request
  body (`--idempotency-key` overrides it). Deploying the same image again
  returns the same deployment.
- **`--tenant`** must match the envelope's tenant, checked before anything
  is sent.
- **`--dry-run`** prints the equivalent `curl` command and sends nothing.
- **The pack service's env, checked first.** When the pack declares `env`,
  the deploy prints the plan for `--env` (see `kindgi env plan`). It refuses
  when a required name has no value or reference in `environments.<env>.env`
  (`--allow-missing-env` deploys anyway, with a warning), or when a secret is
  given in the clear. That case has no override.
- **`--sync-secrets`** also sends the values in `.env.<envName>` to the
  deployment's secrets after it lands. Off by default; without it, a deploy
  with such a file says what it didn't send. With it, secret-shaped names
  (`*_KEY`, `*_TOKEN`, `*_SECRET`, …) get a warning: those belong in
  `kindgi secrets set`.
- **Errors** carry a hint for the common ones: `signature-invalid`,
  `signer-not-trusted`, `image-unverifiable`,
  `deployment-validation-failed`.

## `kindgi env`

```sh
kindgi env list  [--env <name>] [--reveal] [--force-reveal] [--path <dir>]
kindgi env set   <KEY> <VALUE> [--env <name>] [--force] [--path <dir>]
kindgi env unset <KEY> [--env <name>] [--path <dir>]
kindgi env pull  [--env <name>] --scope=<kind>[:id] [--overwrite-existing] [--path <dir>]
kindgi env init  [--secrets-backend=<none|postgres|secret-manager>] [--kms=<gcp|aws|libsodium|vault>] [--out=<path>]
kindgi env plan  [--env <name>] [--format=terraform|gcloud] [--path <dir>]
```

Per-environment values for the pack, in env files next to
`kindgi.config.ts`. `--env` defaults to `staging`.

- **`--env=local`** is the project's own env files, the ones `kindgi dev`
  reads (`.env` < `.env.local`, or `dev.envFiles`). `list` shows the merged
  view and which file each key came from; `set` and `unset` edit only the
  highest-precedence file, and say so when a lower file (the app's `.env`)
  still defines the key.
- **Any other env** is `.env.<envName>`, the file
  `kindgi deploy --sync-secrets` sends.
- **`list`** redacts values; `--reveal` prints them, but not to a pipe
  without `--force-reveal`.
- **`pull`** fetches the env's values from the API into `.env.<envName>`.
- **`init`** writes a `.env.example` for a deployment target.
- **Format:** dotenv, read the way `dotenv` (and Next.js) read it, with
  `${VAR}` expansion. `set` and `unset` touch one key and keep every other
  byte.
- **`KINDGI_*` names are refused:** they configure the runtime and belong in
  its environment, not the pack's.
- **`plan`** shows the process env a deployed pack service gets in `--env`:
  each name the pack declares (`env.required` / `env.optional`) and its source
  in `environments.<env>.env` in `kindgi.config.ts`. A source is a plain value,
  or a Secret Manager reference that the platform resolves with the pack
  service's own identity (Kindgi never sees the value):

  ```ts
  environments: {
    production: {
      env: {
        LOG_LEVEL: 'info',
        DATABASE_URL: { secret: 'acme-db-url', version: '3' },
        // a secret in another project, named by project number:
        SHARED_TOKEN: { secret: 'shared-token', version: '2', project: '123456789012' },
      },
    },
  },
  ```

  It prints the Terraform input (`env` and `secret_env`), or with
  `--format=gcloud` the `--update-env-vars` / `--update-secrets` flags (they add or replace the listed names; the service's other variables stay). It exits 1
  when a required name has no source, or when a secret is given as a plain
  value: by its name (`*_KEY`, `*_TOKEN`, …) or by a credential in it (a URL
  with a password). That value is never printed. A reference to version
  `latest` is read when an instance starts, so a new version needs a new
  revision.

## `kindgi secrets`

```sh
kindgi secrets list|get|set|rotate|revoke|pull --env=<name> --scope=<kind>[:id] …
```

Secrets through the API's `/v1/secrets` routes. Values are never printed and
never returned: `list` and `get` show metadata only, and `pull` writes a
manifest (`.secrets/<envName>/manifest.json`), not the values. `set` and
`rotate` read the value from a no-echo prompt, `--from-stdin` or
`--from-file` (a file others can read is refused). `revoke` keeps an audit
tombstone; `--hard` erases the value. Under `kindgi dev`, `--env=local`
writes to the pack's `.env.local`.

## `kindgi key`

```sh
kindgi key create <keyId> [--env <name>] [--home <dir>]
kindgi key export <keyId> [--format=pem|base64|raw-hex] [--home <dir>]
kindgi key list [--home <dir>]
kindgi key trust <keyId> [--label <text>] [--home <dir>]
kindgi key revoke <keyId> [--reason <text>]
```

Ed25519 signing keys for `kindgi build`, as files under `~/.kindgi/keys/`
(the directory `0700`, `<keyId>.pem` `0600`, `<keyId>.pub.pem` `0644`).

- **`create`** generates a key pair and refuses to overwrite an existing
  one. With `--env`, it prints what to add to that env block in
  `kindgi.config.ts`.
- **`export`** prints the public key only, never the private one.
- **`list`** shows each key pair's id, fingerprint and paths.
- **`trust`** adds a local key's public key to the runtime's trust list
  (`--url`, `--token`), so the runtime accepts deploys it signs. A key id
  stays bound to its key: to rotate, create a key under a new id and trust
  that.
- **`revoke`** removes a key from the trust list. The runtime refuses new
  deploys it signs; deployments it signed keep running, and the key stays
  listed for audit. A revoked id can't be trusted again.

## `kindgi skills`

`kindgi skills sync [--force] [--dry-run]` refreshes `.claude/skills/` from the
skills bundled with this CLI. Skills you edited are kept unless `--force`.
`kindgi dev` mentions it when the installed skills are behind.

## `kindgi mcp`

MCP servers for your coding agent (Claude Code, Cursor, VS Code, …), not for
the runtime:

```sh
kindgi mcp presets
kindgi mcp add postgres --secret=MY_DB_URL
kindgi mcp list
kindgi mcp remove <server-name>
```

`add` writes an entry to `.mcp.json` at the pack root. The entry runs
`kindgi mcp-launch`, which starts the MCP server with the secret from the
pack's env files in its environment, so the secret is never written into
`.mcp.json`. The `kindgi-authoring-mcp-servers` skill covers the details.

## `kindgi feedback`

`kindgi feedback write --kind=bug --title="…"` appends a note about framework
friction to `FEEDBACK.md` at the pack root, where a coding agent can leave
what it diagnosed for the maintainers.

## API commands

These call a running Kindgi API through [`@kindgi/client`](../../sdks/typescript).
Inside a pack that `kindgi dev` runs, they find it on their own (see
[Auth and config](#auth-and-config)).

| Command | Subcommands |
|---|---|
| `projects` | `list`, `get-default`, `get <project-id>`: the ids the `--project=<id>` flags take |
| `provenance` | `list`, `get <run-id>`: each run's graph of what ran; `export <run-id> --signing-key=<id>`, signed |
| `memory facts` | `list` (by `--type`, `--scope`), `get <fact-id>`, `write --input=<json>`: the facts agents remember |
| `conversations` | `list`, `get`, `open <agent-id> <version>`, `close`, `messages` |
| `runs` | `list`, `get`, `cancel`, `journal`, `stream` (one JSON event per line), `start`, `resume` |
| `agents` | `list`, `get <agent-id> [<version>]`, `publish`, `derive`, `unregister <agent-id> <version>`, `versions`; which version runs where: `live`, `live-versions`, `promote`, `rollback`, `unpin`, `promotions` |
| `tools` | `list`, `get`, `publish`, `unregister`, `versions`, `get-version`, `reinstate` |
| `flows` | `list`, `get <flow-id> [<version>]`, `publish --spec=<json>`, `versions`, `unregister <flow-id> <version>`, `reinstate <flow-id> <version>` |
| `guardrails` | `list`, `get`, `register`, `unregister` |
| `providers` | `list`, `get`, `register`, `presets`, `unregister` |
| `capabilities` | `list`, `get`: the features an agent can require, what each means, and your models that have them |
| `artifacts` | `list` (by `--run`, `--project`, `--content-type`), `get`, `upload <file>`, `download <blob-id> [-o <file>]`, `delete`: files kept in the runtime, each in a project |
| `adapters` | `prepare` |
| `approvals` | `list`, `get`, `complete` |
| `reviewers` | `list`, `get`, `register`, `unregister` |
| `health` | `GET /health`, no auth |
| `version` | The CLI's and SDK's versions, and the API's when it's reachable |

`kindgi runs start` starts a run for an agent (`--agent=<id>`) or a flow
(`--flow=<id>`), at its latest version or the one `--agent-version=<v>` /
`--flow-version=<v>` names (a turn in a conversation needs the version the
conversation was opened with), in the tenant's Default project or the one
`--project=<project-id>` names (`kindgi projects list`), and waits until it
finishes, or until it waits on an approval. It follows the run rather than holding the start request open, so
a long run doesn't time it out. Stopped (Ctrl+C), the wait ends and the run
goes on: the CLI prints its id and `kindgi runs get <id>`. `--no-wait`
prints the run as soon as it exists (follow it with `runs get` or `runs
stream`). `--dry-run` runs only the tools declared read-only (`mutating:
false`).

`kindgi <command> --help` prints a command's subcommands and flags.

More of the API (superseding and searching memory, proposals,
observations and tokens) has commands in progress. They're left out of `--help` until they work; until then, use
[`@kindgi/client`](../../sdks/typescript) for those resources.

## Auth and config

The API URL and token come from, in order:

| Source | API URL | Token |
|---|---|---|
| Flag | `--url` | `--token` |
| Environment | `KINDGI_API_URL` | `KINDGI_API_TOKEN` |
| `.kindgirc.json` in the current directory | `apiUrl` | `token` |
| `~/.kindgi/config.json` | `apiUrl` | `token` |

`kindgi dev` writes `.kindgirc.json` in the pack. For another API, save the
pair once with `kindgi auth login --url=<url> --token=<token>`, and check it
with `kindgi auth whoami`.

### The runtime image's registry

The Kindgi runtime image `kindgi dev` runs is in private preview: request
access at contact@kindgi.com. With the pull credentials you receive (a robot
name and a token), log Docker in once:

```sh
kindgi auth registry --username <robot name>     # prompts for the token, without echoing it
printf '%s' "$TOKEN" | kindgi auth registry --username <robot name> --password-stdin
kindgi auth registry --check                      # only check access, no login
```

It runs `docker login` with the token on its stdin, never in its arguments,
so the credential lives in Docker's own credential store: Kindgi stores
nothing. Then it checks that Docker can pull the exact image this CLI runs
(pinned by digest; with `docker buildx imagetools inspect`, or
`docker manifest inspect` by digest where buildx isn't installed), and a
failure says whether it's access (request it at
contact@kindgi.com) or the image or the network. `--registry <host>` logs in
to a mirror instead and checks for the same image there.

## Output and global flags

| Flag | Effect |
|---|---|
| `--json` | Pretty JSON on stdout (the default), for `jq`. |
| `--raw` | One-line JSON. |
| `--table` | A table for list responses (`runs list`, `tools list`, `providers list`; JSON where a list has no columns). |
| `--quiet` | Nothing on stdout; the exit code only. |
| `--url=<url>`, `--token=<token>` | The API and its token (see above). |
| `--verbose`, `-v` | Full errors: stack traces and the API's error bodies. |
| `--version` | The CLI's version. |
| `--help`, `-h` | Help for the CLI or a command. |
