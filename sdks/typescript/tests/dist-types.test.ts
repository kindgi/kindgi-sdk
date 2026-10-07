// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The published types (`dist/index.d.ts`, `dist/index.d.cts`) as an app
 * compiles them, with `skipLibCheck: false`: each name exported once.
 * Needs a prior `pnpm run build`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequire } from 'node:module';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { namesExportedTwice, unexportNamesakes } from '../scripts/dts-namesakes.mjs';
import { unexportPhantomValues, valueExports } from '../scripts/dts-values.mjs';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(PKG_ROOT, 'dist');

/** The names an inlined namesake was exported beside (0.1.3), now once each. */
const NAMESAKES = [
  'ConversationMessage',
  'EvaluationResult',
  'Fact',
  'GeneratedWebhookSecret',
  'MessageRole',
  'ProvidersClient',
  'ReviewerRole',
  'RevokeSigningKeyResult',
  'RunFinishedEvent',
  'TrustedSigningKey',
  'WebhookDelivery',
  'WebhookDeliveryStatus',
  'WebhookEndpoint',
  'WebhookEvent',
  'WebhookSecretRef',
  'WebhookTestEvent',
] as const;

/** The compiler's messages for `source`, compiled as an app would (under node_modules, so `zod` resolves). */
function compile(source: string): string[] {
  const dir = mkdtempSync(join(PKG_ROOT, 'node_modules', '.consumer-'));
  try {
    const file = join(dir, 'consumer.ts');
    writeFileSync(file, source);
    const program = ts.createProgram([file], {
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
    });
    return ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the published types, compiled with skipLibCheck: false', () => {
  it.each(['index.d.ts', 'index.d.cts'])('%s', (file) => {
    expect(existsSync(join(DIST, file)), `${file}: run \`pnpm run build\` first`).toBe(true);
    const from = JSON.stringify(join(DIST, file.replace('.d.ts', '.js').replace('.d.cts', '.cjs')));
    const source = [
      `import type { ${NAMESAKES.join(', ')} } from ${from};`,
      `export type Imported = [${NAMESAKES.join(', ')}];`,
    ].join('\n');
    expect(compile(source)).toEqual([]);
  });
});

describe('the values the published types export', () => {
  it.each([
    ['index.d.ts', 'index.js'],
    ['index.d.cts', 'index.cjs'],
  ])('%s: each is in %s', async (types, runtime) => {
    const declared = valueExports(readFileSync(join(DIST, types), 'utf8'));
    const module: Record<string, unknown> = runtime.endsWith('.cjs')
      ? createRequire(import.meta.url)(join(DIST, runtime))
      : await import(join(DIST, runtime));
    expect(declared).toContain('createClient');
    expect(declared.filter((name) => !(name in module))).toEqual([]);
  });

  it('a generated schema is a type: using it as a value does not compile', () => {
    const from = JSON.stringify(join(DIST, 'index.js'));
    expect(
      compile(`import type { LivePin } from ${from};
export const pin: LivePin | null = null;`),
    ).toEqual([]);
    const asValue = compile(`import { LivePin } from ${from};
LivePin.parse({});`);
    expect(asValue.join('\n')).toContain("'LivePin' only refers to a type");
  });
});

describe('unexportPhantomValues', () => {
  const bundled = [
    'export declare const LivePin: z.ZodObject<{}>;',
    'export type LivePin = Schemas.LivePin;',
    'export declare function createClient(options: unknown): unknown;',
    'export declare function createClient(): unknown;',
    'export declare class KindgiApiError extends Error {\n}',
    'export interface Fact {\n}',
  ].join('\n');

  it('unexports a value the runtime module lacks, and keeps it declared', () => {
    expect(valueExports(bundled)).toEqual(['LivePin', 'createClient', 'KindgiApiError']);
    const out = unexportPhantomValues(bundled, ['createClient', 'KindgiApiError']);
    expect(valueExports(out)).toEqual(['createClient', 'KindgiApiError']);
    expect(out.split('\n')).toContain('declare const LivePin: z.ZodObject<{}>;');
    expect(out).toContain('export type LivePin = Schemas.LivePin;');
    expect(out).toContain('export interface Fact {');
  });
});

describe('unexportNamesakes', () => {
  const bundled = [
    'export interface Fact<T = unknown> {\n\treadonly content: T;\n}',
    'export type MessageRole = "user" | "assistant";',
    'export declare const MessageRole: unknown;',
    'interface Fact$1 {\n\treadonly version: number;\n}',
    'type MessageRole$1 = "user" | "assistant" | "system";',
    'export interface FactFilter {\n\treadonly fact?: Fact$1;\n}',
    'export {\n\tFact$1 as Fact,\n\tMessageRole$1 as MessageRole,\n};',
  ].join('\n');

  it('names each export once: the renamed one, the namesake unexported', () => {
    expect(namesExportedTwice(bundled)).toEqual(['Fact', 'MessageRole']);
    const out = unexportNamesakes(bundled);
    expect(namesExportedTwice(out)).toEqual([]);
    expect(out).toContain('interface Fact<T = unknown> {');
    expect(out).not.toContain('export interface Fact<');
    expect(out).toContain('\ntype MessageRole = "user" | "assistant";');
    expect(out).toContain('\ndeclare const MessageRole: unknown;');
    expect(out).toContain('Fact$1 as Fact');
  });

  it('leaves other declarations as they are', () => {
    const out = unexportNamesakes(bundled);
    expect(out).toContain('export interface FactFilter {');
  });
});
