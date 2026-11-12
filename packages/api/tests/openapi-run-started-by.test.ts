// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A run's `startedBy`, its `keyCeiling` (a test run's too) and its
 * trigger's `kind` list exactly the runtime's values, and each description
 * names every value, so a new kind of start can't reach the wire
 * unexplained.
 */

import { RUN_KEY_CEILINGS, RUN_STARTED_BY, RUN_TRIGGER_KINDS } from '@kindgi/runtime';
import { describe, expect, test } from 'vitest';

import { RunSchema, RunTriggerSchema, TestRunSchema } from '../src/openapi/schemas.js';

type Field = { readonly enum?: readonly string[]; readonly description?: string };

const startedBy = (RunSchema.properties as Record<string, Field>).startedBy;
const triggerKind = (RunTriggerSchema.properties as Record<string, Field>).kind;

describe("a run's startedBy", () => {
  test("lists exactly the runtime's values", () => {
    expect(startedBy?.enum).toEqual([...RUN_STARTED_BY]);
  });

  test.each(RUN_STARTED_BY)('its description names `%s`', (value) => {
    expect(startedBy?.description).toContain(`\`${value}\``);
  });
});

/** A run, and a test run, a key with a ceiling started: each is marked. */
const MARKED = [
  ['run', RunSchema],
  ['test run', TestRunSchema],
] as const;

describe.each(MARKED)("a %s's keyCeiling", (_name, schema) => {
  const keyCeiling = (schema.properties as Record<string, Field>).keyCeiling;

  test("lists exactly the runtime's values, and isn't required", () => {
    expect(keyCeiling?.enum).toEqual([...RUN_KEY_CEILINGS]);
    expect((schema as { required?: readonly string[] }).required ?? []).not.toContain('keyCeiling');
  });

  test.each(RUN_KEY_CEILINGS)('its description names `%s`', (value) => {
    expect(keyCeiling?.description).toContain(`\`${value}\``);
  });
});

describe("a run's trigger kind", () => {
  test("lists exactly the runtime's values", () => {
    expect(triggerKind?.enum).toEqual([...RUN_TRIGGER_KINDS]);
  });

  test.each(RUN_TRIGGER_KINDS)("the trigger's description names `%s`", (value) => {
    expect(RunTriggerSchema.description).toContain(`\`${value}\``);
  });
});
