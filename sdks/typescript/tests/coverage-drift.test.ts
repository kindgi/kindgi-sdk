// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
// reads-source: packages/api/openapi.json sdks/typescript/scripts/gen-client.mjs sdks/typescript/src/resources/*.ts

/**
 * SDK ↔ HTTP wire coverage drift.
 *
 * Every endpoint that appears in `sdks/typescript/src/generated/api.ts`
 * (auto-generated from `@kindgi/api/openapi.json` via typed-openapi) must be
 * reachable through at least one hand-written resource client in
 * `sdks/typescript/src/resources/*.ts`. When a new HTTP route lands on
 * the server, the whole chain — API OPERATIONS entry → openapi.json →
 * generated types → resource client method — must be complete before
 * consumers can call it. This test catches the last hop: "we regen'd
 * the generated types but forgot to write the ergonomic wrapper."
 *
 * Complementary to `packages/api/tests/openapi.test.ts`, which
 * catches the first hop (routes with no OPERATIONS entry).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const GENERATED = join(PKG_ROOT, 'src', 'generated', 'api.ts');
const RESOURCES_DIR = join(PKG_ROOT, 'src', 'resources');

// Normalize a path template to a comparison key. Two example inputs:
//   /v1/schedules/{triggerId}/pause     →  /v1/schedules/*/pause
//   /v1/schedules/(interpolated)/pause  →  /v1/schedules/*/pause
//   /v1/schedules                       →  /v1/schedules
// Preserves structural segments so /v1/foo/bar and /v1/foo/{bar}
// don't collide.
function normalize(path: string): string {
  return path
    .replace(/\?.*$/, '') // strip trailing query strings
    .replace(/\$\{[^}]+\}/g, '*') // template-literal interpolations
    .replace(/\{[^}]+\}/g, '*'); // openapi param placeholders
}

/** Extract every path literal from the generated typed-openapi module. */
function generatedPaths(): readonly string[] {
  const src = readFileSync(GENERATED, 'utf8');
  const matches = src.matchAll(/path: z\.literal\("([^"]+)"\)/g);
  const paths = new Set<string>();
  for (const m of matches) paths.add(m[1]!);
  return [...paths];
}

/**
 * Every path a resource file calls: a `path: '/v1/foo'` or `path: "/v1/foo"`
 * literal, a template `` path: `/v1/foo/${id}` ``, and the URLs streaming
 * callers build, `` `${transport.apiUrl}/v1/test-runs/${seg(id)}/events` ``
 * or `buildUrl(transport.apiUrl, '/v1/corrections/export', query)`.
 */
function callerPaths(src: string): string[] {
  const patterns = [
    /path:\s*['"]([^'"]+)['"]/g,
    /path:\s*`([^`]+)`/g,
    /`\$\{transport\.apiUrl\}(\/v1\/[^`]+)`/g,
    /buildUrl\(\s*transport\.apiUrl,\s*['"`]([^'"`]+)['"`]/g,
  ];
  return patterns.flatMap((re) => [...src.matchAll(re)].map((m) => m[1]!));
}

/** Every path the resource files call, normalized. */
function resourcePathSet(): ReadonlySet<string> {
  const paths = new Set<string>();
  const files = readdirSync(RESOURCES_DIR).filter((f) => f.endsWith('.ts'));
  for (const f of files) {
    const src = readFileSync(join(RESOURCES_DIR, f), 'utf8');
    for (const p of callerPaths(src)) paths.add(normalize(p));
  }
  return paths;
}

describe('SDK ↔ generated wire coverage — every endpoint has a resource wrapper', () => {
  test('no generated path is missing a resource-client method', () => {
    const wrapped = resourcePathSet();
    const missing: string[] = [];
    for (const raw of generatedPaths()) {
      // Legitimate skips + acknowledged backlog. Every entry needs a
      // reason; anything without a reason is real drift that should
      // block a commit. Remove an entry when its resource-client method
      // lands (or when the endpoint is retired). See:
      //   docs/ADDING-A-ROUTE.md — full authoring checklist
      const SKIP: Readonly<Record<string, string>> = {
        // Meta surfaces the SDK CONSUMES, not wraps.
        '/v1/openapi.json': 'SDK codegen input, not a caller path',
        '/health': 'deployment probe, not a caller path',

        // Deployment-side warmup SSE — runtime dev/preview workflow,
        // not part of the SDK's caller-facing ergonomics.
        '/v1/adapters/{adapterId}/prepare':
          'adapters.prepare — deployment-side warmup SSE; not caller-facing',

        // The inbound receiver: a webhook trigger's sender (WooCommerce,
        // Drupal, GitHub…) posts to it, signed with the trigger's secret.
        '/v1/hooks/{tenantId}/{webhookId}':
          "hooks.receive — a signed sender's path (the trigger's receiveUrl), not this client's",
        '/v1/connection-notices/{tenantId}/{appId}':
          "connectionNotices.receive — a signed sender's path (the registration's noticesUrl), not this client's",

        // The link a pausing tool hands to another system, which answers
        // the run's wait there; this client answers with `runs.resume`.
        '/v1/wait-tokens/{token}/complete':
          "waitTokens.complete — the answering system's path (a pausing tool's link), not this client's",

        // The link a tool that stores or reads files has its bytes posted to
        // and got from: a pack service posts each store there and gets each
        // read from under it, with the call's tool files token.
        '/v1/tool-files':
          "toolFiles.store — a pack service's path (a call's toolFiles link), not this client's",
        '/v1/tool-files/{artifactId}':
          "toolFiles.read — a pack service's path (under a call's toolFiles link), not this client's",
      };
      if (raw in SKIP) continue;
      if (!wrapped.has(normalize(raw))) missing.push(raw);
    }
    expect(
      missing,
      `Generated endpoints with no hand-written resource-client wrapper:\n${missing
        .map((p) => `  ${p}`)
        .join(
          '\n',
        )}\n\nA new HTTP route made it through openapi.json + typed-openapi codegen,\nbut nobody wrote a matching resource-client method in\nsdks/typescript/src/resources/*.ts. Fix by adding the client method\n(follow the pattern in schedules.ts / orgs.ts / etc.) and its test file.`,
    ).toEqual([]);
  });

  test('every resource path resolves to a real generated endpoint (no dangling)', () => {
    const generated = new Set(generatedPaths().map(normalize));
    const orphans: string[] = [];
    const files = readdirSync(RESOURCES_DIR).filter((f) => f.endsWith('.ts'));
    for (const f of files) {
      const src = readFileSync(join(RESOURCES_DIR, f), 'utf8');
      for (const p of new Set(callerPaths(src))) {
        if (!generated.has(normalize(p))) orphans.push(`${f}: ${p}`);
      }
    }
    expect(
      orphans,
      `Resource-client paths that don't match any generated endpoint:\n${orphans
        .map((o) => `  ${o}`)
        .join(
          '\n',
        )}\n\nEither the wire route was removed or the resource-client method has\na typo. Either way — one side must catch up.`,
    ).toEqual([]);
  });
});
