// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Post-`tsc` step for `@kindgi/cli` build. Copies non-TS assets into
 * `dist/` so the published tarball is self-contained:
 *   - `src/templates/` → `dist/templates/` (scaffold templates)
 *   - `src/mcp/presets/`, `src/providers/presets/` → `dist/…` (MCP and provider presets)
 *   - `src/dev/docker-compose.dev.yml` → `dist/dev/…` (kindgi dev bundle)
 *   - chmod +x on `dist/cli.js` so `kindgi` is executable
 *
 * The console isn't bundled: the Kindgi runtime image serves its own.
 */

import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(scriptDir);
const distDir = join(pkgRoot, 'dist');

cpSync(join(pkgRoot, 'src', 'templates'), join(distDir, 'templates'), { recursive: true });
cpSync(join(pkgRoot, 'src', 'mcp', 'presets'), join(distDir, 'mcp', 'presets'), {
  recursive: true,
});
cpSync(join(pkgRoot, 'src', 'providers', 'presets'), join(distDir, 'providers', 'presets'), {
  recursive: true,
});
cpSync(
  join(pkgRoot, 'src', 'dev', 'docker-compose.dev.yml'),
  join(distDir, 'dev', 'docker-compose.dev.yml'),
);

// Bundle @kindgi/sdk skills into the CLI so `kindgi init` can copy
// them into scaffolded packs' `.claude/skills/` without depending on
// the SDK being installed in the target project's node_modules yet
// (init runs BEFORE pnpm install). Version-pinned to CLI release;
// upgrading the SDK independently would drift — acceptable while SDK
// and CLI release together; revisit if their versions diverge.
// Resolved by package name (the CLI depends on @kindgi/sdk), so this works
// whether the SDK is a workspace sibling or lives in another checkout.
const sdkRoot = dirname(createRequire(import.meta.url).resolve('@kindgi/sdk/package.json'));
const sdkSkillsSrc = join(sdkRoot, 'skills');
if (!existsSync(sdkSkillsSrc)) {
  console.error(
    `[copy-build-assets] @kindgi/sdk skills/ not found at ${sdkSkillsSrc}\n  The SDK must have a skills/ folder authored before the CLI is built.\n`,
  );
  process.exit(1);
}
cpSync(sdkSkillsSrc, join(distDir, 'sdk-skills'), { recursive: true });

// Stamp each SKILL.md's `sdk_version` frontmatter with the SDK's
// current version at build time. Source SKILL.md files carry `0.0.0`
// (the SDK's pre-release value). At every CLI release, `pnpm publish`
// bumps the SDK's version; this substitution propagates that version
// into shipped skills so operators reading the frontmatter see the
// SDK release the skill was shipped with.
//
// Note: `sdk_version` is INFORMATIONAL — it tells the user "which
// SDK release shipped this skill". Sync decisions key on the per-skill
// `version` field (author-maintained) + content hash. The two axes
// are intentional: `version` moves when skill CONTENT changes;
// `sdk_version` moves when the SDK RELEASE ships.
const sdkPkgRaw = readFileSync(join(sdkRoot, 'package.json'), 'utf8');
const sdkVersion = JSON.parse(sdkPkgRaw).version;
if (typeof sdkVersion !== 'string' || sdkVersion.length === 0) {
  console.error('[copy-build-assets] Could not read SDK version from @kindgi/sdk/package.json');
  process.exit(1);
}
const skillsDistDir = join(distDir, 'sdk-skills');
for (const skillName of readdirSync(skillsDistDir)) {
  const skillPath = join(skillsDistDir, skillName, 'SKILL.md');
  if (!existsSync(skillPath)) continue;
  const original = readFileSync(skillPath, 'utf8');
  const stamped = original.replace(
    /^sdk_version:\s*"?[^"\n]+"?\s*$/m,
    `sdk_version: "${sdkVersion}"`,
  );
  if (stamped !== original) writeFileSync(skillPath, stamped);
}

await chmod(join(distDir, 'cli.js'), 0o755);
