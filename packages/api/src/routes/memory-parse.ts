// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** Request parsing for `/v1/memory`: fact writes, supersedes, retrieve intents and query values. */

import type { FactSubject, MemoryScope, Retention } from '@kindgi/memory';
import type { Timestamp } from '@kindgi/types';

import type { MemoryRetrieveIntent } from '../memory-binding.js';
import { parseTimeInput } from './time-input.js';

export type ValidationResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'err'; readonly message: string };

const ok = <T>(value: T): ValidationResult<T> => ({ kind: 'ok', value });
const err = <T>(message: string): ValidationResult<T> => ({ kind: 'err', message });

const MAX_SUBJECTS = 20;

export function parseScopeParam(raw: string): Partial<MemoryScope> | null {
  try {
    const decoded = JSON.parse(raw) as unknown;
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
    return decoded as Partial<MemoryScope>;
  } catch {
    return null;
  }
}

/** An ISO 8601 time, as a query value or a body field. */
export function parseTime(raw: unknown, field: string): ValidationResult<Timestamp | undefined> {
  if (raw === undefined) return ok(undefined);
  const at = parseTimeInput(raw);
  if (at === null) return err(`\`${field}\` must be an ISO 8601 time`);
  return ok(at.toISOString() as Timestamp);
}

/** A revision number: a whole number of 1 or more. */
export function parseVersion(raw: unknown, field: string): ValidationResult<number | undefined> {
  if (raw === undefined) return ok(undefined);
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    return err(`\`${field}\` must be a revision number (1 or more)`);
  }
  return ok(n);
}

function parseScope(raw: unknown): ValidationResult<MemoryScope> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return err('Field `scope` must be an object');
  }
  const scope = raw as Record<string, unknown>;
  if (typeof scope.tenantId !== 'string') return err('Field `scope.tenantId` must be a string');
  if (
    scope.participantId !== undefined &&
    (typeof scope.participantId !== 'string' || scope.participantId.length === 0)
  ) {
    return err('Field `scope.participantId` must be a non-empty string');
  }
  if (scope.participantId !== undefined && scope.projectId === undefined) {
    return err(
      "`scope.participantId` needs `scope.projectId`: an app's end users belong to a project",
    );
  }
  return ok(scope as unknown as MemoryScope);
}

function parseRetention(raw: unknown): ValidationResult<Retention | undefined> {
  if (raw === undefined) return ok(undefined);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return err('Field `retention` must be an object when present');
  }
  const r = raw as Record<string, unknown>;
  const keepUntil = parseTime(r.keepUntil, 'retention.keepUntil');
  if (keepUntil.kind === 'err') return keepUntil;
  if (
    r.keepDays !== undefined &&
    (typeof r.keepDays !== 'number' || !Number.isInteger(r.keepDays) || r.keepDays < 1)
  ) {
    return err('`retention.keepDays` must be a whole number of days (1 or more)');
  }
  if (r.legalHold !== undefined && typeof r.legalHold !== 'boolean') {
    return err('`retention.legalHold` must be true or false');
  }
  return ok(r as Retention);
}

function parseSubjects(raw: unknown): ValidationResult<readonly FactSubject[] | undefined> {
  if (raw === undefined) return ok(undefined);
  const shape =
    "Field `subjects` is a list of whom the fact is about: [{ kind: 'participant' | 'user' | 'external', id }]";
  if (!Array.isArray(raw) || raw.length > MAX_SUBJECTS) {
    return err(`${shape}, at most ${MAX_SUBJECTS}`);
  }
  for (const s of raw) {
    const o = s as Record<string, unknown> | null;
    if (
      o === null ||
      typeof o !== 'object' ||
      !['participant', 'user', 'external'].includes(o.kind as string) ||
      typeof o.id !== 'string' ||
      o.id.length === 0 ||
      Object.keys(o).length !== 2
    ) {
      return err(shape);
    }
  }
  return ok(raw as FactSubject[]);
}

/** The fields a write and a supersede share: retention, subjects and the times. */
export interface ValidatedFactFields {
  readonly retention?: Retention;
  readonly subjects?: readonly FactSubject[];
  readonly validFrom?: Timestamp;
  readonly validUntil?: Timestamp;
  readonly observedAt?: Timestamp;
}

function parseFactFields(body: Record<string, unknown>): ValidationResult<ValidatedFactFields> {
  const retention = parseRetention(body.retention);
  if (retention.kind === 'err') return retention;
  const subjects = parseSubjects(body.subjects);
  if (subjects.kind === 'err') return subjects;
  const times: Record<string, Timestamp> = {};
  for (const field of ['validFrom', 'validUntil', 'observedAt'] as const) {
    const t = parseTime(body[field], field);
    if (t.kind === 'err') return t;
    if (t.value !== undefined) times[field] = t.value;
  }
  if (
    times.validFrom !== undefined &&
    times.validUntil !== undefined &&
    times.validFrom > times.validUntil
  ) {
    return err('`validFrom` must not be after `validUntil`');
  }
  return ok({
    ...(retention.value !== undefined && { retention: retention.value }),
    ...(subjects.value !== undefined && { subjects: subjects.value }),
    ...times,
  });
}

export interface ValidatedWriteFactBody extends ValidatedFactFields {
  readonly type: string;
  readonly scope: MemoryScope;
  readonly content: unknown;
  readonly contentHash?: string;
}

export function validateWriteFactBody(
  body: Record<string, unknown>,
): ValidationResult<ValidatedWriteFactBody> {
  const type = body.type;
  if (typeof type !== 'string' || type.length === 0) {
    return err('Field `type` must be a non-empty string');
  }
  const scope = parseScope(body.scope);
  if (scope.kind === 'err') return scope;
  if (!('content' in body)) return err('Field `content` is required');
  const rawContentHash = body.contentHash;
  if (
    rawContentHash !== undefined &&
    (typeof rawContentHash !== 'string' || rawContentHash.length === 0)
  ) {
    return err('Field `contentHash` must be a non-empty string when present');
  }
  const fields = parseFactFields(body);
  if (fields.kind === 'err') return fields;
  return ok({
    type,
    scope: scope.value,
    content: body.content,
    ...(typeof rawContentHash === 'string' && { contentHash: rawContentHash }),
    ...fields.value,
  });
}

export interface ValidatedSupersedeBody extends ValidatedFactFields {
  readonly content: unknown;
  readonly expectVersion?: number;
}

export function validateSupersedeBody(
  body: Record<string, unknown>,
): ValidationResult<ValidatedSupersedeBody> {
  if (!('content' in body)) {
    return err("Field `content` is required: the fact's next revision");
  }
  const expectVersion = parseVersion(body.expectVersion, 'expectVersion');
  if (expectVersion.kind === 'err') return expectVersion;
  const fields = parseFactFields(body);
  if (fields.kind === 'err') return fields;
  return ok({
    content: body.content,
    ...(expectVersion.value !== undefined && { expectVersion: expectVersion.value }),
    ...fields.value,
  });
}

export function validateRetrieveIntent(
  body: Record<string, unknown>,
): ValidationResult<MemoryRetrieveIntent> {
  const mode = body.mode;
  if (mode !== 'list' && mode !== 'keyword' && mode !== 'semantic' && mode !== 'both') {
    return err('Field `mode` must be one of "list", "keyword", "semantic", "both"');
  }
  const rawQuery = body.query;
  if (rawQuery !== undefined && typeof rawQuery !== 'string') {
    return err('Field `query` must be a string when present');
  }
  if ((mode === 'keyword' || mode === 'semantic' || mode === 'both') && rawQuery === undefined) {
    return err(`Field \`query\` is required when \`mode\` is "${mode}"`);
  }
  const rawType = body.type;
  if (rawType !== undefined && (typeof rawType !== 'string' || rawType.length === 0)) {
    return err('Field `type` must be a non-empty string when present');
  }
  const rawScope = body.scope;
  if (
    rawScope !== undefined &&
    (rawScope === null || typeof rawScope !== 'object' || Array.isArray(rawScope))
  ) {
    return err('Field `scope` must be an object when present');
  }
  const rawLimit = body.limit;
  if (
    rawLimit !== undefined &&
    (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit) || rawLimit < 1)
  ) {
    return err('Field `limit` must be a positive number when present');
  }
  const rawEmbeddingModel = body.embeddingModel;
  if (
    rawEmbeddingModel !== undefined &&
    (typeof rawEmbeddingModel !== 'string' || rawEmbeddingModel.length === 0)
  ) {
    return err('Field `embeddingModel` must be a non-empty string when present');
  }
  return ok({
    mode,
    ...(typeof rawQuery === 'string' && { query: rawQuery }),
    ...(typeof rawType === 'string' && { type: rawType }),
    ...(rawScope !== undefined && { scope: rawScope as Partial<MemoryScope> }),
    ...(typeof rawLimit === 'number' && { limit: Math.floor(rawLimit) }),
    ...(typeof rawEmbeddingModel === 'string' && { embeddingModel: rawEmbeddingModel }),
  });
}
