// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Production wiring for the deploy runners. Lazy-loaded from
 * `main.ts` ONLY when the dispatched command is `deploy` — the
 * `runBuild` runner pulls in the full build defaults tree (esbuild
 * / tar / docker / crypto). Commands that never invoke deploy don't
 * pay that transitive load.
 *
 * The `runBuild` inline-build path is best-effort: if it fails, the
 * error is surfaced via `RunBuildResult.kind = 'err'` — the deploy
 * command translates that into an actionable stderr message.
 */

import { loadEnvelopeReal } from './envelope-loader.js';
import { postDeploymentReal, syncSecretsReal } from './post.js';
import type { DeployRunners } from './runners.js';

/**
 * Production `DeployRunners`. `runBuild` is intentionally OMITTED here
 * — the deploy command re-uses its own already-parsed
 * `ctx.buildRunners` + calls into `runBuild` from `commands/build.ts`
 * directly (importing the runner would create a cycle). Instead the
 * command reaches for `ctx.buildRunners`; production wires
 * `buildRunners` via `main.ts`'s existing lazy loader.
 *
 * This keeps the deploy path production-wired end-to-end without
 * duplicating the build-runners production loader here.
 */
export const REAL_DEPLOY_RUNNERS: DeployRunners = {
  loadEnvelope: loadEnvelopeReal,
  postDeployment: postDeploymentReal,
  // Production sync runner. Only invoked when
  // `--sync-secrets` is passed AND `.env.<envName>` carries entries.
  syncSecrets: syncSecretsReal,
  // runBuild deliberately omitted — the command composes it from
  // `ctx.buildRunners` + the exported `runBuild` from
  // `commands/build.ts`.
};
