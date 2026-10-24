---
title: Add Kindgi to a TypeScript or Node app
description: Add Kindgi to the TypeScript or Node app you already have, so your tools are your app's own code.
sidebar:
  order: 5.1
  label: "Existing app: TypeScript"
---

This page adds Kindgi to a TypeScript or Node app you already have. The pack
lives beside your code: its tools import your app's modules.

**Before you start**, set up what the [Install page](../install/) describes:
Node 22.12 or later, Docker, and access to the runtime image. In the app's
folder, `npx --yes @kindgi/cli@0.2 doctor` checks all three, and says how to
fix what's missing.

:::tip[Your coding agent can do most of this]
`kindgi init` gives your app Kindgi's skills, in `.claude/skills/` and
`.agents/skills/`. After that, you can ask your coding agent instead of
following each step: "make a Kindgi tool from our order lookup", "add an
agent that uses it", "run it". It writes the code next to yours, runs it
with `kindgi dev`, and asks you for your model's key. [How it knows
Kindgi](../coding-agents/).
:::

In the app's root (where its `package.json` is), with no pack name:

```sh
npx --yes @kindgi/cli@0.2 init
pnpm install
```

- `npx --yes @kindgi/cli@0.2` runs the newest 0.2 release of the Kindgi CLI
  without installing it ([Check this machine](../install/#check-this-machine)
  says how).
- `init` with no pack name adds Kindgi to the app in this folder. The
  pack's id comes from the `name` in the app's `package.json`. If there's no
  name, or `init` says it doesn't make a pack id, add `--pack-id=<id>`:
  lowercase letters, digits and dashes, starting with a letter, such as
  `--pack-id=acme-support`. The app's `name` stays as it is.
- Run your app's own package manager's install in place of `pnpm install`.
- If your app's pnpm sets `minimumReleaseAge`, `pnpm install` refuses a
  Kindgi release younger than that. Wait until the release is old enough, or
  install the release before it (`@kindgi/cli@<version>` and
  `@kindgi/sdk@<version>`). The setting protects your app's dependencies, so
  leave it as it is.

`init` prints what it made, as JSON and then as a summary. `pnpm install`
ends with `Done`:

```text
…
  Kindgi added to …/acme-support (augment mode).
  Pack id: acme-support    Version: 0.1.0
  Wrote 19 files; skipped 0.
…
Done in 4.9s using pnpm v10.28.0
```

`init` adds:

- the pack's config: its id (from the app's name), version, and where its
  primitives live. It's `kindgi.config.ts` in an app whose `package.json`
  says `"type": "module"`, and `kindgi.config.mts` in any other;
- a `kindgi/` folder for the primitives: `kindgi/tools/`, `kindgi/agents/`,
  `kindgi/guardrails/`, `kindgi/flows/`. In an app that isn't
  `"type": "module"`, it also gets a one-line `package.json` that makes
  them ES modules;
- **the SDK and the CLI,** at the CLI's own version: `@kindgi/sdk` (a
  dependency) and `@kindgi/cli` (a devDependency);
- **`zod`,** at the version Kindgi is tested with. That's `4.6.5` exactly if
  your app pins exact versions or its package manager saves them, otherwise
  `^4.6.5`. If your app already has `zod`, `init` keeps it;
- **the tests `kindgi test` runs:** `vitest` and `vite` in
  `devDependencies`, pinned the same way, and a vitest config
  ([Test your tools](#test-your-tools));
- **in a pnpm app,** `allowBuilds: { esbuild: false }` in
  `pnpm-workspace.yaml`. pnpm 11 and later won't install until every
  dependency's install script has a decision, and esbuild (the CLI's
  bundler) doesn't need its script. A decision the app already has, `true`
  or `false`, is kept;
- **in an npm app,** the same decision in `package.json`'s `allowScripts`
  (`"esbuild": false`). Without it, npm 11 warns on the first install that
  esbuild's script is "not yet covered by allowScripts". npm 10 ignores the
  field. A decision the app already has, for `esbuild` or a pinned
  `esbuild@<version>`, is kept;
- the skills for your coding agent under `.claude/skills/` and
  `.agents/skills/`, and
  `.gitignore` entries (`.kindgi/`, `.kindgirc.json`, `.env.local`).

If your app is on zod 3, `init` keeps it, and a Kindgi schema written with
zod 3 doesn't compile: Kindgi takes zod 4 schemas. Write your tools' and
agents' inputs and outputs as JSON Schema objects instead. Moving the app
to zod 4 is a change to the app's own code (zod 4 changes some of zod 3's
API, such as `invalid_type_error`), so it's the app owner's decision. A
tool's input as JSON Schema:

```ts excerpt
input: {
  type: 'object',
  additionalProperties: false,
  required: ['orderId'],
  properties: { orderId: { type: 'string' } },
},
```

It creates no env files: `kindgi dev` reads your app's own `.env` and
`.env.local`, and keeps the secrets you store in its own
`.kindgi/secrets.env`, which your app doesn't load. If your app lints with ESLint, leave out what Kindgi builds:
add `".kindgi/**"` to the `globalIgnores` in `eslint.config.mjs`. To keep
the pack separate from the app instead, pass `--new-repo`.

## Your code as a tool

A tool imports your app's modules like any other file in it, path aliases
(`@/…`) included. Ask your coding agent: "Make a Kindgi tool from our
support request lookup." For reference, the tool looks like this:

```ts
// kindgi/tools/get-request/index.ts
import { defineTool } from '@kindgi/sdk/define';
import type { ToolId } from '@kindgi/sdk/types';
import { z } from 'zod';

import { findRequest } from '@/lib/requests'; // your app's own code

const defined = defineTool({
  id: 'acme-support.get-request' as ToolId,
  description: 'Looks up a support request by its id (REQ-1234).',
  version: '0.1.0',
  input: z.object({ id: z.string() }),
  output: z.object({
    found: z.boolean(),
    subject: z.string().optional(),
    body: z.string().optional(),
  }),
  effects: [],
  mutating: false,
  handler: async ({ id }) => {
    const request = findRequest(id);
    return request
      ? { found: true, subject: request.subject, body: request.body }
      : { found: false };
  },
});

if (defined.kind === 'err') throw new Error(defined.error.message);
export default defined.value;
```

Ids start with the pack's id (`acme-support`, from the app's name).
`mutating: false` says the tool only reads, so a dry run may call it.

A package a tool imports (an ORM client such as `@prisma/client`, an API
SDK) must be in your app's `dependencies`, not `devDependencies`: the
deployed pack installs production dependencies only, so a dev-only import
works under `kindgi dev` and fails once deployed. `kindgi dev` warns when a
tool imports one, and `kindgi build` refuses the pack until it moves.
Build-time tools (the `prisma` CLI, `typescript`) stay in `devDependencies`.
A default import of a package that ships only CommonJS can give a tool
something other than what your app gets:
see [A CommonJS package in TypeScript](../../guides/tools/write-a-tool/#a-commonjs-package-in-typescript).

### Code that imports `server-only`

A tool can't import a module that starts with `import 'server-only'`, as
Next.js server code often does, or a module that imports one. That line is
for Next.js's build, which refuses a client component that imports the
module. Anywhere else, it stops the module from loading, so `kindgi test`,
`kindgi dev` and `kindgi build` (and so `kindgi deploy`) fail on the tool.

When your app doesn't have the `server-only` package (Next.js doesn't need
it), none of the pack's code builds, and `kindgi dev` loads none of it:

```text
…
  Indexer failed: [bundle-failed] The pack's code did not build:
      lib/requests.ts:1:7: Could not resolve "server-only"
…
```

When it has the package, `kindgi dev` loads the pack without that tool. The
error is the package's own, though a tool isn't a Client Component:

```text
…
    ⚠ indexer: kindgi/tools/get-request/index.ts [file-import-failed] Failed to import kindgi/tools/get-request/index.ts: Error: This module cannot be imported from a Client Component module. It should only be used from a Server Component.
…
```

Keep the line, and move the code the tool needs into a module without it.
Ask your coding agent: "Our request lookup imports server-only: share it
with the Kindgi tool." For reference, the code in `lib/requests.ts` moves,
as it is, to `lib/requests-core.ts`, without the `import 'server-only'`
line. `lib/requests.ts` keeps the line and passes the code on, so your
app's own imports don't change:

```ts
// lib/requests.ts
import 'server-only';

export * from './requests-core';
```

The tool imports the module without the line:

```ts excerpt
// in kindgi/tools/get-request/index.ts
import { findRequest } from '@/lib/requests-core'; // your app's own code
```

Next.js's build still refuses a client component that imports
`lib/requests.ts`. Nothing guards `lib/requests-core.ts`, so import it only
from your app's server code and from the pack.

## An agent that uses it

Ask your coding agent: "Add an agent that reads a support request and sets
its priority." For reference, the agent looks like this:

```ts
// kindgi/agents/triage/index.ts
import { defineAgent } from '@kindgi/sdk/define';
import type { AgentId, Semver } from '@kindgi/sdk/types';
import { z } from 'zod';

const defined = defineAgent({
  id: 'acme-support.triage' as AgentId,
  version: '0.1.0' as Semver,
  name: 'Triage',
  description: 'Reads a support request and sets its priority.',
  instructions:
    'The user names a support request id. Look it up with the get-request tool, ' +
    'then answer with its priority and a one-sentence summary.',
  capabilities: [{ needs: [{ feature: 'tool-use' as const }] }],
  tools: [{ id: 'acme-support.get-request', version: '^0.1.0' }],
  retrieval: [],
  guardrails: [],
  output: {
    schema: z.object({
      priority: z.enum(['low', 'normal', 'urgent']),
      summary: z.string(),
    }),
  },
  budget: { maxSteps: 4, maxCostUsd: 0.05, maxWallMs: 60_000 },
});

if (defined.kind === 'err') throw new Error(defined.error.message);
export default defined.value;
```

`output` makes the answer typed: the model has to answer with JSON that
fits the schema, and your app gets it as an object.

## Run it

```sh
pnpm exec kindgi dev
```

`kindgi dev` builds the pack from `kindgi/`, runs its tools in a process
started from your app's root, and reloads on every save.

When it's up, its banner names the project and its database:

```text
…
    ✓ Kindgi is up
…
    Project    acme-support · database kindgi_acme_support
…
```

Until you register a model, agents answer with `dev-echo`, which only checks
the wiring: it calls the agent's first tool with `{"message": …}` and can't
produce a typed answer, so this agent fails with `output-schema-violation`.
Register a model first, with your AI model provider's API key:

```sh
pnpm exec kindgi secrets set <KEY_NAME> --env=local --scope=tenant   # prompts for the key; it isn't echoed
pnpm exec kindgi providers register --preset=<preset>
pnpm exec kindgi runs start --agent=acme-support.triage --input='{"userMessage":"Triage REQ-1002"}'
```

With Anthropic's key, for example, the three commands print:

```text
…
  Set ANTHROPIC_API_KEY at tenant in local.
…
✓ Registered anthropic: claude-opus-5-5, claude-sonnet-5-5 (default), claude-haiku-5-5, claude-haiku-4-5 — key ANTHROPIC_API_KEY (env local)
…
  "status": "completed",
…
    "output": {
      "summary": "User unable to log in due to expired password with non-functional password reset email delivery.",
      "priority": "urgent"
    },
```

`<KEY_NAME>` and `<preset>` depend on the provider:

| Provider | `<KEY_NAME>` | `<preset>` |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| Gemini (a Google AI Studio key) | `GEMINI_API_KEY` | `gemini-api` |
| Groq | `GROQ_API_KEY` | `groq` |
| OpenRouter (a hosted gateway) | `OPENROUTER_API_KEY` | `openrouter` |

To have `kindgi dev` register the model on every boot, in each worktree and
after `--reset`, declare it in the pack's config:
[Declare them in your pack's config](../../guides/models/#declare-them-in-your-packs-config).

## Test your tools

A tool's tests go beside it (`kindgi/tools/get-request/index.test.ts`), and
`kindgi test` runs them:

```sh
pnpm exec kindgi test
```

With two tests beside `get-request`, it prints vitest's summary:

```text
…
 Test Files  1 passed (1)
      Tests  2 passed (2)
…
```

`init` sets this up. It writes `vitest.config.mts` at the app's
root (`vitest.config.ts` in a `"type": "module"` app), which runs
`kindgi/**/*.test.ts` and none of your app's own tests. vitest doesn't read
`tsconfig.json`, so the config copies its `paths` (Next.js's `@/*`) into
`resolve.alias`, and a tool that imports `@/lib/requests` works under test
as it does in your app. When you change those paths, change the config to
match: `init`'s summary names the ones it copied.

An app that runs vitest already keeps its own setup, and `init` says what
`kindgi test` needs from it: a `vitest.config.*` at the root whose
`test.include` covers `kindgi/**/*.test.ts`, with the aliases your tools
import by.

## What the pack's image needs

`kindgi build` turns the pack into an image. It installs your app's
production dependencies with install scripts off, so your app's own
`postinstall` and `prepare` scripts don't run there, and the build says so:

```text
    ✓ The app's own install scripts don't run in the image: postinstall (`prisma generate`)
```

When the image needs what such a script does, say so under `image` in
`kindgi.config.ts`.

**Prisma.** A tool that uses Prisma's client needs `prisma generate` in the
image. Without it the build fails when it loads the pack:

```text
kindgi-index: file-import-failed: Failed to import kindgi/tools/find-order/index.ts: Error: @prisma/client did not initialize yet. Please run "prisma generate" and try to import it again.
```

`prisma()` copies the schema into the image and runs `prisma generate` after
the install. Ask your coding agent: "Run prisma generate in the pack's
image." For reference, it adds this to `kindgi.config.ts`:

```ts excerpt
// in kindgi.config.ts
import { prisma } from '@kindgi/sdk/build';

const config = {
  // pack, discovery and environments, as kindgi init wrote them
  image: {
    extensions: [prisma({ schema: 'prisma/schema.prisma' })],
  },
};
```

With a `prisma.config.ts`, name it too:
`prisma({ schema: 'prisma/schema.prisma', config: 'prisma.config.ts' })`.

A build step's tool is often a dev dependency (the `prisma` CLI), so with
build steps the install takes your dev dependencies too, and drops them after
the steps; without any, it installs production dependencies only. Yarn 2 or
later always takes them and drops them after, as its production install
resolves what `yarn.lock` lacks instead of failing, even with
`enableImmutableInstalls` on. The build says which:

```text
    ✓ Install: dev dependencies too, for the build steps (prisma), whose tools can be dev dependencies; pruned to production after
```

The install reads your registry config (`.npmrc`, and Yarn's `.yarnrc` or
`.yarnrc.yml`) while it runs, and the image never holds it. When a slow
registry makes the install time out, give each download longer, in
milliseconds. With pnpm 10, in `.npmrc`:

```ini excerpt
fetch-timeout=180000
fetch-retries=4
```

pnpm 11 and later don't read these from `.npmrc`: set them in
`pnpm-workspace.yaml`, which the install takes too:

```yaml excerpt
fetchTimeout: 180000
fetchRetries: 4
```

**Also under `image`:**
- `systemPackages`: Debian packages the image needs, such as
  `['tesseract-ocr']`.
- `buildEnv`: placeholder variables for the install, the build steps and
  loading your modules while building, such as
  `{ DATABASE_URL: 'postgresql://build-placeholder' }`. Never secrets: they're
  set while building only, and the final image doesn't have them. Your modules
  load with `NODE_ENV=production` while building, as in the deployed service,
  unless `buildEnv` sets `NODE_ENV`. A `NODE_ENV` in `buildEnv` doesn't change
  which dependencies the install takes.
- **patch-package:** when a skipped script runs it, `kindgi build` prints the
  build step to add (`defineBuildExtension`, also from `@kindgi/sdk/build`).
  With pnpm, `pnpm patch` applies your patches in the install itself.
- `dependencies: 'loaded'`: the image downloads only the packages your tools
  import, with their own dependencies, instead of every production dependency
  of your app. On a Next.js app whose tools import `@kindgi/sdk` and `zod`, the
  build says:

  ```text
      ✓ Install: only what the pack loads, 39 of the lockfile's 96 packages; production dependencies only
        Left out 3 of the pack's own dependencies its tools don't import: next, react, react-dom
  ```

  A package your code loads by a name no import shows (a plugin named in a
  config string) goes in `keep: ['pino-pretty']`. Most misses fail the build,
  naming the package. What no check can see, such as a package loaded by a
  name in a string, fails that call at run time, saying what to add to `keep`.
  A `node_modules` out of date with your lockfile fails the build, saying what
  to run. In a few cases, such as Yarn 2 or later or a local package (`link:`,
  `file:`, `workspace:`) among what your tools import, the image downloads
  everything and trims it after; the build says why. `'all'` is the default.

The build ends with the image and a check of what's in it:

```text
    ✓ Built kindgi-pack/acme-orders:20261008.193804 (sha256:9e102b60f643…)
    ✓ /app/index.json in the image matches the local index byte for byte
```

[Self-host with Docker](../../deploy/self-hosted/self-host/) pushes, signs and deploys it.

## Next

- [Start runs from your app](../call-from-your-app/): your app calls the
  agent and reads its answer.
- [Write a tool](../../guides/tools/write-a-tool/): inputs, outputs, effects
  and tests.
- [Write an agent](../../guides/agents/write-an-agent/).

<!-- check-samples: stand-ins for your app's own code that the samples above import; the docs' sample check reads them, readers don't see them.

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "paths": { "@/*": ["./*"] }
  },
  "include": ["lib/**/*.ts", "kindgi/**/*.ts"]
}
```

```ts
// lib/requests-core.ts
export function findRequest(id: string): { subject: string; body: string } | undefined {
  return id === 'REQ-1234' ? { subject: 'Refund', body: 'I was charged twice.' } : undefined;
}
```
-->
