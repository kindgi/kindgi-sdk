// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Facade re-export contract tests.
 *
 * These tests verify:
 *   1. Every value exported by `@kindgi/sdk/{define,client,types}` resolves.
 *   2. Value re-exports are REFERENCE-IDENTICAL to their source (`===`) — the
 *      facade is a pass-through, not a wrapper.
 *   3. Type re-exports preserve type identity (`expectTypeOf(...).toEqualTypeOf(...)`).
 *   4. Sub-path imports resolve via the package's `exports` map (Node/TS NodeNext).
 *   5. The flat barrel (`@kindgi/sdk`) is disjoint — no name collisions
 *      between the three sub-paths. `/webhooks` is server-only and stays out
 *      of the barrel.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

// ---------- Sub-path: /define ----------
import {
  defineAgent,
  defineCheck,
  defineFlow,
  defineTool,
  defineToolAsync,
  isZodSchema,
  toJSONSchema,
} from '@kindgi/sdk/define';
import type {
  Agent,
  AnySchema,
  DefineAgentSpec,
  DefineCheckSpec,
  DefineToolSpec,
  DefinedCheck,
  DefinedTool,
  EdgePolicy,
  FanoutNode,
  Flow,
  FlowSpec,
  InferCheckConfig,
  InferInput,
  InferOutput,
  LoopNode,
  SubflowNode,
  Tool,
  ToolContext,
  ToolManifest,
  ZodLikeSchema,
} from '@kindgi/sdk/define';

// ---------- Sub-path: /client ----------
import {
  KindgiApiError,
  createClient,
  followRun,
  fromWire,
  notImplementedInPreview,
  notYetWired,
  readSse,
  subscribeToRun,
  unwrapSseData,
} from '@kindgi/sdk/client';
import type {
  AgentsClient,
  AuthError,
  ClientOptions,
  KindgiClient,
  KindgiError,
  RunProgressEvent,
  RunsClient,
  SseEvent,
  SubscribeToRunOptions,
  ToolsClient,
  Transport,
  TransportRequest,
} from '@kindgi/sdk/client';

// ---------- Sub-path: /webhooks (server only) ----------
import {
  WEBHOOK_HEADERS,
  generateWebhookSecret,
  signWebhook,
  verifyWebhook,
  webhookHeaders,
} from '@kindgi/sdk/webhooks';
import type { VerifyWebhookInput, VerifyWebhookResult } from '@kindgi/sdk/webhooks';

// ---------- Sub-path: /types ----------
import type {
  AgentId,
  Brand,
  Cursor,
  Result,
  RunId,
  TenantId,
  Timestamp,
  ToolId,
} from '@kindgi/sdk/types';

import * as sdk from '@kindgi/sdk';
// ---------- Flat barrel: @kindgi/sdk ----------
import * as sdkBuild from '@kindgi/sdk/build';

// ---------- Source packages (identity checks) ----------
import { defineAgent as defineAgentFromAgents } from '@kindgi/agents';
import {
  createClient as createClientFromClient,
  followRun as followRunFromClient,
  subscribeToRun as subscribeToRunFromClient,
} from '@kindgi/client';
import type {
  RunProgressEvent as RunProgressEventFromClient,
  SubscribeToRunOptions as SubscribeToRunOptionsFromClient,
} from '@kindgi/client';
import {
  WEBHOOK_HEADERS as WEBHOOK_HEADERS_FROM_CRYPTO,
  generateWebhookSecret as generateWebhookSecretFromCrypto,
  signWebhook as signWebhookFromCrypto,
  verifyWebhook as verifyWebhookFromCrypto,
  webhookHeaders as webhookHeadersFromCrypto,
} from '@kindgi/crypto';
import type {
  VerifyWebhookInput as VerifyWebhookInputFromCrypto,
  VerifyWebhookResult as VerifyWebhookResultFromCrypto,
} from '@kindgi/crypto';
import { defineFlow as defineFlowFromGraph } from '@kindgi/flow';
import { defineCheck as defineCheckFromGuardrails } from '@kindgi/guardrails';
import * as buildExtensions from '@kindgi/handler-runtime/build-extensions';
import {
  isZodSchema as isZodSchemaFromSchema,
  toJSONSchema as toJSONSchemaFromSchema,
} from '@kindgi/schema';
import { defineTool as defineToolFromTools } from '@kindgi/tools';

describe('@kindgi/sdk/define — pack authoring re-exports', () => {
  it('re-exports defineTool identically (===) from @kindgi/tools', () => {
    expect(defineTool).toBeDefined();
    expect(defineTool).toBe(defineToolFromTools);
  });

  it('re-exports defineToolAsync, defineCheck, defineAgent as functions (identity-preserving)', () => {
    expect(typeof defineToolAsync).toBe('function');
    expect(defineCheck).toBe(defineCheckFromGuardrails);
    expect(defineAgent).toBe(defineAgentFromAgents);
  });

  it('re-exports defineFlow identically (===) from @kindgi/flow', () => {
    expect(defineFlow).toBeDefined();
    expect(defineFlow).toBe(defineFlowFromGraph);
  });

  it('re-exports Zod-optional helpers identically from @kindgi/schema', () => {
    expect(isZodSchema).toBe(isZodSchemaFromSchema);
    expect(toJSONSchema).toBe(toJSONSchemaFromSchema);
  });

  it('preserves DefineToolSpec type identity across the facade', () => {
    expectTypeOf<DefineToolSpec<AnySchema, AnySchema>>().toEqualTypeOf<
      import('@kindgi/tools').DefineToolSpec<AnySchema, AnySchema>
    >();
  });

  it('preserves DefineCheckSpec type identity across the facade', () => {
    expectTypeOf<DefineCheckSpec<AnySchema>>().toEqualTypeOf<
      import('@kindgi/guardrails').DefineCheckSpec<AnySchema>
    >();
  });

  it('preserves DefineAgentSpec type identity across the facade', () => {
    expectTypeOf<DefineAgentSpec>().toEqualTypeOf<import('@kindgi/agents').DefineAgentSpec>();
  });

  it('exports flow node + edge policy types identically', () => {
    expectTypeOf<Flow>().toEqualTypeOf<import('@kindgi/flow').Flow>();
    expectTypeOf<FlowSpec>().toEqualTypeOf<import('@kindgi/flow').FlowSpec>();
    expectTypeOf<LoopNode>().toEqualTypeOf<import('@kindgi/flow').LoopNode>();
    expectTypeOf<FanoutNode>().toEqualTypeOf<import('@kindgi/flow').FanoutNode>();
    expectTypeOf<SubflowNode>().toEqualTypeOf<import('@kindgi/flow').SubflowNode>();
    expectTypeOf<EdgePolicy>().toEqualTypeOf<import('@kindgi/flow').EdgePolicy>();
  });

  it('exports tool + check + agent primitive types identically', () => {
    expectTypeOf<Tool<unknown, unknown>>().toEqualTypeOf<
      import('@kindgi/tools').Tool<unknown, unknown>
    >();
    expectTypeOf<ToolManifest>().toEqualTypeOf<import('@kindgi/tools').ToolManifest>();
    expectTypeOf<ToolContext>().toEqualTypeOf<import('@kindgi/tools').ToolContext>();
    expectTypeOf<DefinedTool<AnySchema, AnySchema>>().toEqualTypeOf<
      import('@kindgi/tools').DefinedTool<AnySchema, AnySchema>
    >();
    expectTypeOf<InferInput<AnySchema>>().toEqualTypeOf<
      import('@kindgi/tools').InferInput<AnySchema>
    >();
    expectTypeOf<InferOutput<AnySchema>>().toEqualTypeOf<
      import('@kindgi/tools').InferOutput<AnySchema>
    >();
    expectTypeOf<DefinedCheck<AnySchema>>().toEqualTypeOf<
      import('@kindgi/guardrails').DefinedCheck<AnySchema>
    >();
    expectTypeOf<InferCheckConfig<AnySchema>>().toEqualTypeOf<
      import('@kindgi/guardrails').InferCheckConfig<AnySchema>
    >();
    expectTypeOf<Agent>().toEqualTypeOf<import('@kindgi/agents').Agent>();
    expectTypeOf<ZodLikeSchema>().toEqualTypeOf<import('@kindgi/schema').ZodLikeSchema>();
  });
});

describe('@kindgi/sdk/client — client callsite re-exports', () => {
  it('re-exports createClient identically (===) from @kindgi/client', () => {
    expect(createClient).toBeDefined();
    expect(createClient).toBe(createClientFromClient);
  });

  it('re-exports the error surface as callable values', () => {
    expect(KindgiApiError).toBeDefined();
    expect(typeof fromWire).toBe('function');
    expect(typeof notImplementedInPreview).toBe('function');
    expect(typeof notYetWired).toBe('function');
  });

  it('re-exports SSE streaming helpers', () => {
    expect(typeof readSse).toBe('function');
    expect(typeof unwrapSseData).toBe('function');
  });

  it('createClient returns a shaped KindgiClient object', () => {
    const client: KindgiClient = createClient({
      apiUrl: 'http://localhost:4000',
      auth: { kind: 'apiToken', token: 'kgi_bt_test' },
    });
    expect(client).toBeDefined();
    expect(client.agents).toBeDefined();
    expect(client.runs).toBeDefined();
    expect(client.tools).toBeDefined();
  });

  it('preserves resource client type identity', () => {
    expectTypeOf<AgentsClient>().toEqualTypeOf<import('@kindgi/client').AgentsClient>();
    expectTypeOf<RunsClient>().toEqualTypeOf<import('@kindgi/client').RunsClient>();
    expectTypeOf<ToolsClient>().toEqualTypeOf<import('@kindgi/client').ToolsClient>();
    expectTypeOf<ClientOptions>().toEqualTypeOf<import('@kindgi/client').ClientOptions>();
  });

  it('exports transport + streaming + error types identically', () => {
    expectTypeOf<Transport>().toEqualTypeOf<import('@kindgi/client').Transport>();
    expectTypeOf<TransportRequest>().toEqualTypeOf<import('@kindgi/client').TransportRequest>();
    expectTypeOf<SseEvent<unknown>>().toEqualTypeOf<import('@kindgi/client').SseEvent<unknown>>();
    expectTypeOf<AuthError>().toEqualTypeOf<import('@kindgi/client').AuthError>();
    expectTypeOf<KindgiError>().toEqualTypeOf<import('@kindgi/client').KindgiError>();
  });
});

describe('@kindgi/sdk/client — following a run', () => {
  it('re-exports subscribeToRun and followRun identically (===) from @kindgi/client', () => {
    expect(subscribeToRun).toBe(subscribeToRunFromClient);
    expect(followRun).toBe(followRunFromClient);
  });

  it('preserves the run-following types across the facade', () => {
    expectTypeOf<SubscribeToRunOptions>().toEqualTypeOf<SubscribeToRunOptionsFromClient>();
    expectTypeOf<RunProgressEvent>().toEqualTypeOf<RunProgressEventFromClient>();
  });
});

describe('@kindgi/sdk/webhooks — receiving Kindgi webhooks (server only)', () => {
  it('re-exports the Standard Webhooks helpers identically (===) from @kindgi/crypto', () => {
    expect(verifyWebhook).toBe(verifyWebhookFromCrypto);
    expect(generateWebhookSecret).toBe(generateWebhookSecretFromCrypto);
    expect(signWebhook).toBe(signWebhookFromCrypto);
    expect(webhookHeaders).toBe(webhookHeadersFromCrypto);
    expect(WEBHOOK_HEADERS).toBe(WEBHOOK_HEADERS_FROM_CRYPTO);
  });

  it('preserves the verify types across the facade', () => {
    expectTypeOf<VerifyWebhookInput>().toEqualTypeOf<VerifyWebhookInputFromCrypto>();
    expectTypeOf<VerifyWebhookResult>().toEqualTypeOf<VerifyWebhookResultFromCrypto>();
  });

  it('verifies what it signs: an app can test its receiver with the sdk alone', () => {
    const secret = generateWebhookSecret();
    const body = JSON.stringify({ type: 'run.finished' });
    const headers = webhookHeaders({
      secret,
      id: 'msg_1',
      timestamp: Math.floor(Date.now() / 1000),
      body,
    });
    if (headers.kind !== 'ok') throw new Error('signing failed');
    expect(verifyWebhook({ secret, headers: headers.value, body }).kind).toBe('ok');
  });

  it('stays out of the flat barrel (it uses node:crypto)', () => {
    expect((sdk as Record<string, unknown>).verifyWebhook).toBeUndefined();
  });
});

describe('@kindgi/sdk/types — branded IDs + Result envelope', () => {
  it('preserves branded ID type identity across the facade', () => {
    expectTypeOf<AgentId>().toEqualTypeOf<import('@kindgi/types').AgentId>();
    expectTypeOf<RunId>().toEqualTypeOf<import('@kindgi/types').RunId>();
    expectTypeOf<ToolId>().toEqualTypeOf<import('@kindgi/types').ToolId>();
    expectTypeOf<TenantId>().toEqualTypeOf<import('@kindgi/types').TenantId>();
    expectTypeOf<Cursor>().toEqualTypeOf<import('@kindgi/types').Cursor>();
    expectTypeOf<Timestamp>().toEqualTypeOf<import('@kindgi/types').Timestamp>();
  });

  it('exports Result envelope + Brand helper', () => {
    // Discriminate on `kind` matches the workspace-wide Result convention.
    const ok: Result<number, string> = { kind: 'ok', value: 42 };
    const err: Result<number, string> = { kind: 'err', error: 'boom' };
    expect(ok.kind).toBe('ok');
    expect(err.kind).toBe('err');
    if (ok.kind === 'ok') expect(ok.value).toBe(42);
    if (err.kind === 'err') expect(err.error).toBe('boom');

    // Brand<T, B> is a compile-only marker; assert the alias identity.
    expectTypeOf<Brand<string, 'MyId'>>().toEqualTypeOf<
      import('@kindgi/types').Brand<string, 'MyId'>
    >();
  });
});

describe('@kindgi/sdk — flat barrel', () => {
  it('re-exports defineTool + createClient via the barrel', () => {
    expect(sdk.defineTool).toBe(defineToolFromTools);
    expect(sdk.createClient).toBe(createClientFromClient);
  });

  it('barrel names are disjoint (no /define ↔ /client ↔ /types collision)', () => {
    // If any name collided, `export *` chaining would either drop one export
    // silently or fail typecheck. Sample every layer + assert value presence.
    expect(sdk.defineTool).toBeDefined();
    expect(sdk.defineToolAsync).toBeDefined();
    expect(sdk.defineCheck).toBeDefined();
    expect(sdk.defineAgent).toBeDefined();
    expect(sdk.defineFlow).toBeDefined();
    expect(sdk.isZodSchema).toBeDefined();
    expect(sdk.toJSONSchema).toBeDefined();
    expect(sdk.createClient).toBeDefined();
    expect(sdk.KindgiApiError).toBeDefined();
    expect(sdk.fromWire).toBeDefined();
    expect(sdk.notImplementedInPreview).toBeDefined();
    expect(sdk.notYetWired).toBeDefined();
    expect(sdk.readSse).toBeDefined();
    expect(sdk.unwrapSseData).toBeDefined();
    expect(sdk.subscribeToRun).toBeDefined();
    expect(sdk.followRun).toBeDefined();
  });
});

describe("@kindgi/sdk/build — a pack image's build extensions", () => {
  it('re-exports the helpers verbatim', () => {
    expect(sdkBuild.prisma).toBe(buildExtensions.prisma);
    expect(sdkBuild.defineBuildExtension).toBe(buildExtensions.defineBuildExtension);
  });

  it('is not in the flat barrel: only a config imports it', () => {
    expect('prisma' in sdk).toBe(false);
  });
});
