// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Liquid } from 'liquidjs';

import { compileInlineSchema } from '@kindgi/schema';
import type { Result, TenantId } from '@kindgi/types';

import { validatePromptParameters } from './define.js';
import type { PromptParameter } from './types.js';

/**
 * Data blocks: versioned content an agent version pins and an expert
 * can edit without code: a prompt, or settings.
 *
 * A block is published like a tool (head plus immutable versions,
 * unregister and reinstate), into a project. An agent references one by
 * range, and the version it runs is pinned when the agent version is
 * published, so an edit reaches an agent only through a new agent
 * version, which is what gets compared, tested and promoted.
 */
export const BLOCK_KINDS = ['prompt', 'settings'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/**
 * A prompt: a Liquid template rendered as an agent's instructions are,
 * with the same declared parameters and auto-injected variables.
 */
export interface PromptBlockContent {
  readonly template: string;
  readonly parameters?: readonly PromptParameter[];
}

/**
 * Settings: a JSON object a tool reads (`ToolContext.settings`) and a
 * prompt template reads (`settings.<block id>.<key>`). With `schema`,
 * `values` must satisfy it, and so must a later version's.
 */
export interface SettingsBlockContent {
  readonly values: Readonly<Record<string, unknown>>;
  /** JSON Schema (draft 2020-12) the values must satisfy. */
  readonly schema?: Readonly<Record<string, unknown>>;
}

interface BlockBase {
  /** Dotted id, like an agent's (`acme.intake-prompt`). */
  readonly id: string;
  /** Plain `major.minor.patch`. */
  readonly version: string;
  readonly description?: string;
}

/** A block version as it's published. */
export type BlockDefinition =
  | (BlockBase & { readonly kind: 'prompt'; readonly content: PromptBlockContent })
  | (BlockBase & { readonly kind: 'settings'; readonly content: SettingsBlockContent });

export interface BlockIssue {
  readonly path: string;
  readonly message: string;
}

export interface InvalidBlock {
  readonly code: 'invalid-block';
  readonly message: string;
  readonly issues: readonly BlockIssue[];
}

const ID = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
const VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Validate a block version's definition: its id, plain semver version,
 * kind, and content for that kind. A prompt's template must parse as
 * Liquid and its parameters follow an agent's rules. Settings values
 * must be an object, satisfying `schema` when it's set (and `schema`
 * must compile).
 */
export function validateBlock(input: unknown): Result<BlockDefinition, InvalidBlock> {
  const issues: BlockIssue[] = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return invalid([{ path: '', message: 'a block must be an object' }]);
  }
  const b = input as Record<string, unknown>;
  if (typeof b.id !== 'string' || !ID.test(b.id)) {
    issues.push({
      path: '/id',
      message: 'id must be a dotted lowercase id, e.g. "acme.intake-prompt"',
    });
  }
  if (typeof b.version !== 'string' || !VERSION.test(b.version)) {
    issues.push({ path: '/version', message: 'version must be major.minor.patch, e.g. "1.0.0"' });
  }
  if (b.description !== undefined && typeof b.description !== 'string') {
    issues.push({ path: '/description', message: 'description must be a string' });
  }
  if (b.kind === 'prompt') issues.push(...promptIssues(b.content));
  else if (b.kind === 'settings') issues.push(...settingsIssues(b.content));
  else issues.push({ path: '/kind', message: `kind must be one of: ${BLOCK_KINDS.join(', ')}` });
  if (issues.length > 0) return invalid(issues);

  const { id, version, kind, content, description } = b as unknown as BlockDefinition;
  return {
    kind: 'ok',
    value: {
      id,
      version,
      kind,
      content,
      ...(description !== undefined && { description }),
    } as BlockDefinition,
  };
}

/**
 * Whether settings `values` satisfy a JSON `schema`: the problems, none
 * when they do. A later version's values are checked against the
 * latest version's schema too, so a tool reading them sees a stable
 * shape.
 */
export function settingsSchemaIssues(
  values: unknown,
  schema: Readonly<Record<string, unknown>>,
  path = '/content/values',
): BlockIssue[] {
  const compiled = compileInlineSchema(schema);
  if (compiled.kind === 'err') {
    return [{ path: '/content/schema', message: compiled.error.message }];
  }
  const checked = compiled.value.validate(values);
  if (checked.kind === 'ok') return [];
  return checked.error.errors.map((e) => {
    const err = e as { readonly instancePath?: string; readonly message?: string };
    return { path: `${path}${err.instancePath ?? ''}`, message: err.message ?? 'invalid' };
  });
}

function promptIssues(content: unknown): BlockIssue[] {
  if (content === null || typeof content !== 'object') {
    return [
      { path: '/content', message: 'a prompt block needs content: { template, parameters? }' },
    ];
  }
  const c = content as Record<string, unknown>;
  if (typeof c.template !== 'string' || c.template.trim().length === 0) {
    return [{ path: '/content/template', message: 'template must be a non-empty string' }];
  }
  const issues: BlockIssue[] = [];
  try {
    new Liquid().parse(c.template);
  } catch (cause) {
    issues.push({
      path: '/content/template',
      message: `template isn't valid Liquid: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
  if (c.parameters !== undefined && !Array.isArray(c.parameters)) {
    issues.push({ path: '/content/parameters', message: 'parameters must be an array' });
  } else {
    issues.push(
      ...validatePromptParameters(c.parameters as readonly PromptParameter[] | undefined).map(
        (i) => ({ path: `/content${i.path}`, message: i.message }),
      ),
    );
  }
  return issues;
}

function settingsIssues(content: unknown): BlockIssue[] {
  if (content === null || typeof content !== 'object') {
    return [{ path: '/content', message: 'a settings block needs content: { values, schema? }' }];
  }
  const c = content as Record<string, unknown>;
  if (c.values === null || typeof c.values !== 'object' || Array.isArray(c.values)) {
    return [{ path: '/content/values', message: 'values must be a JSON object' }];
  }
  if (c.schema === undefined) return [];
  if (c.schema === null || typeof c.schema !== 'object' || Array.isArray(c.schema)) {
    return [{ path: '/content/schema', message: 'schema must be a JSON Schema object' }];
  }
  return settingsSchemaIssues(c.values, c.schema as Readonly<Record<string, unknown>>);
}

function invalid(issues: readonly BlockIssue[]): Result<never, InvalidBlock> {
  return {
    kind: 'err',
    error: {
      code: 'invalid-block',
      message: `The block is invalid (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
      issues,
    },
  };
}

/**
 * What a model-settings block's values may set: the model-call knobs a
 * turn passes on. Checked when an agent version that references the
 * block (`Agent.modelSettings`) is published.
 */
export const MODEL_SETTINGS_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    maxOutputTokens: { type: 'integer', minimum: 1 },
  },
};

/** The model-call knobs of a model-settings block. */
export interface ModelSettings {
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

/**
 * Reads data blocks for an agent turn: an exact version (an unregistered
 * one included, for the agent versions that pin it), and a block's
 * active versions (to resolve a range for an agent version with no
 * pins). The runtime supplies it over its block registry.
 */
export interface BlockReader {
  getVersion(input: {
    readonly tenantId: TenantId;
    readonly blockId: string;
    readonly version: string;
  }): Promise<BlockDefinition | null>;
  activeVersions(input: {
    readonly tenantId: TenantId;
    readonly blockId: string;
  }): Promise<readonly string[]>;
}
