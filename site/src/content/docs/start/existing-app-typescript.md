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
Node 22.12 or later, Docker, and access to the runtime image.

:::tip[Your coding agent can do most of this]
`kindgi init` gives your app Kindgi's skills, in `.claude/skills/`. After
that, you can ask your coding agent instead of following each step: "make
a Kindgi tool from our order lookup", "add an agent that uses it", "run
it". It writes the code next to yours, runs it with `kindgi dev`, and asks
you for your model's key. [How it knows Kindgi](../coding-agents/).
:::

In the app's root (where its `package.json` is), with no pack name:

```sh
npx --yes @kindgi/cli@0.1 init
pnpm install
```

- `npx --yes @kindgi/cli@0.1` runs the newest 0.1 release of the Kindgi CLI
  without installing it ([Check this machine](../install/#check-this-machine)
  says how).
- `init` with no pack name adds Kindgi to the app in this folder.
- Run your app's own package manager's install in place of `pnpm install`.

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
- the skills for your coding agent under `.claude/skills/`, and
  `.gitignore` entries (`.kindgi/`, `.kindgirc.json`, `.env.local`).

It creates no env files: `kindgi dev` reads your app's own `.env` and
`.env.local`, and keeps the secrets you store in its own
`.kindgi/secrets.env`, which your app doesn't load. If your app lints with ESLint, leave out what Kindgi builds:
add `".kindgi/**"` to the `globalIgnores` in `eslint.config.mjs`. To keep
the pack separate from the app instead, pass `--new-repo`.

## Your code as a tool

A tool imports your app's modules like any other file in it, path aliases
(`@/…`) included:

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

## An agent that uses it

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

Until you register a model, agents answer with `dev-echo`, which only checks
the wiring: it calls the agent's first tool with `{"message": …}` and can't
produce a typed answer, so this agent fails with `output-schema-violation`.
Register a model first:

```sh
pnpm exec kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant   # prompts for the key; it isn't echoed
pnpm exec kindgi providers register --preset=anthropic
pnpm exec kindgi runs start --agent=acme-support.triage --input='{"userMessage":"Triage REQ-1002"}'
```

```text
  "status": "completed",
…
    "output": {
      "summary": "User unable to log in due to expired password with non-functional password reset email delivery.",
      "priority": "urgent"
    },
```

To have `kindgi dev` register the model on every boot, in each worktree and
after `--reset`, declare it in the pack's config:
[Declare them in your pack's config](../../guides/models/#declare-them-in-your-packs-config).

## Test your tools

A tool's tests go beside it (`kindgi/tools/get-request/index.test.ts`), and
`kindgi test` runs them:

```sh
pnpm exec kindgi test
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
the install:

```ts
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

**Also under `image`:**
- `systemPackages`: Debian packages the image needs, such as
  `['tesseract-ocr']`.
- `buildEnv`: placeholder variables for the build steps and for loading your
  modules while building, such as
  `{ DATABASE_URL: 'postgresql://build-placeholder' }`. Never secrets: they're
  set while building only, and the final image doesn't have them.
- **patch-package:** when a skipped script runs it, `kindgi build` prints the
  build step to add (`defineBuildExtension`, also from `@kindgi/sdk/build`).
  With pnpm, `pnpm patch` applies your patches in the install itself.

The build ends with the image and a check of what's in it:

```text
    ✓ Built kindgi-pack/acme-orders:20261008.193804 (sha256:9e102b60f643…)
    ✓ /app/index.json in the image matches the local index byte for byte
```

[Self-host with Docker](../../deploy/self-host/) pushes, signs and deploys it.

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
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src/**/*.ts", "kindgi/**/*.ts"]
}
```

```ts
// src/lib/requests.ts
export function findRequest(id: string): { subject: string; body: string } | undefined {
  return id === 'REQ-1234' ? { subject: 'Refund', body: 'I was charged twice.' } : undefined;
}
```
-->
