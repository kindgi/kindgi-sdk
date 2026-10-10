// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/sdk/define` — pack authoring surface.
 *
 * Re-exports the authoring primitives from the individual packages
 * (`@kindgi/tools`, `@kindgi/guardrails`, `@kindgi/agents`,
 * `@kindgi/flow`, `@kindgi/schema`) verbatim — no renaming, no
 * behavior. Consumers reading those packages' docs find matching
 * symbols here.
 *
 * The SDK facade is the recommended public developer surface. The
 * individual packages remain importable directly.
 *
 * @module @kindgi/sdk/define
 */

// ---- Tools ----
export {
  defineTool,
  defineToolAsync,
  invokeTool,
  registerToolSpecSynthesizer,
  toolContextForTest,
} from '@kindgi/tools';
export type {
  DefinedTool,
  DefineToolSpec,
  HttpAuthSpec,
  HttpHeaderSpec,
  HttpMethod,
  HttpRequestBodySpec,
  HttpToolSpec,
  InferInput,
  InferOutput,
  Tool,
  ToolContext,
  ToolManifest,
  ToolSecretRef,
  ToolSpec,
  ToolSpecSynthesizer,
} from '@kindgi/tools';

// ---- Guardrails (checks) ----
export { defineCheck } from '@kindgi/guardrails';
export type { DefineCheckSpec, DefinedCheck, InferCheckConfig } from '@kindgi/guardrails';

// ---- Agents ----
export { defineAgent } from '@kindgi/agents';
export type { Agent, DefineAgentSpec } from '@kindgi/agents';

// ---- Flow ----
//
// `defineFlow` is the author-facing primitive that mirrors `defineTool`
// / `defineCheck` / `defineAgent` — a thin wrapper over `loadFlow` that
// runs the same validation gauntlet and returns `Result<Flow,
// FlowError>`. Pack authors reach for `defineFlow` in TypeScript;
// `loadFlow` remains the wire-form entry point for JSON coming off disk
// / network.
export { defineFlow } from '@kindgi/flow';
export type {
  EdgePolicy,
  FanoutNode,
  Flow,
  FlowSpec,
  LoopNode,
  SubflowNode,
} from '@kindgi/flow';

// ---- Zod-optional helpers ----
//
// Direct access for callers that prefer to convert / inspect schemas
// themselves rather than let `defineTool` / `defineCheck` do it implicitly.
export { isZodSchema, toJSONSchema } from '@kindgi/schema';
export type { AnySchema, ZodLikeSchema } from '@kindgi/schema';
