// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { OPENAPI, OUT, render, shapesOf } from './gen-webhook-event-shapes.mjs';

const openapi = () => JSON.parse(readFileSync(OPENAPI, 'utf8'));
const schemas = (doc) => doc.components.schemas;
const runFields = (shapes) => shapes['run.finished'].required.data.required.run;

test('the committed shapes are what the schema generates (check:webhook-shapes)', () => {
  assert.equal(readFileSync(OUT, 'utf8'), render(shapesOf(openapi())));
});

test('every event the API sends, by its type', () => {
  assert.deepEqual(Object.keys(shapesOf(openapi())).sort(), [
    'approval.requested',
    'improvement-pass.finished',
    'run.finished',
    'webhook.test',
  ]);
});

test('control: an enum added to a string field reaches its shape', () => {
  const doc = openapi();
  schemas(doc).FinishedRun.properties.flowId.enum = ['acme.answer'];
  assert.deepEqual(runFields(shapesOf(doc)).required.flowId, {
    kind: 'string',
    enum: ['acme.answer'],
  });
});

test('control: a required field added at depth (a sixth token count) reaches its shape', () => {
  const doc = openapi();
  const tokens = schemas(doc).CostTokenTotals;
  tokens.properties.audio = { type: 'integer', minimum: 0 };
  tokens.required = [...tokens.required, 'audio'];
  const usage = runFields(shapesOf(doc)).optional.usage;
  assert.deepEqual(usage.required.tokens.required.audio, { kind: 'integer', minimum: 0 });
});

test('control: a uuid format on a field reaches its shape', () => {
  const doc = openapi();
  schemas(doc).RequestedApproval.properties.approvalId.format = 'uuid';
  const approval = shapesOf(doc)['approval.requested'].required.data.required.approval;
  assert.deepEqual(approval.required.approvalId, { kind: 'string', format: 'uuid' });
});

test("a keyword the checker doesn't read fails the generation, naming where", () => {
  const doc = openapi();
  schemas(doc).CostTokenTotals.properties.prompt.multipleOf = 2;
  assert.throws(
    () => shapesOf(doc),
    /CostTokenTotals\.prompt: "multipleOf" on a integer isn't a keyword/,
  );
});

test('a format, a type or a oneOf it cannot check fails the generation', () => {
  const format = openapi();
  schemas(format).RequestedApproval.properties.url.format = 'uri';
  assert.throws(() => shapesOf(format), /format "uri" isn't one the checker reads/);
  const type = openapi();
  schemas(type).FinishedRun.properties.flowVersion.type = ['string', 'integer'];
  assert.throws(() => shapesOf(type), /type \["string","integer"\] isn't one the checker reads/);
  const union = openapi();
  schemas(union).LiveScope.discriminator = undefined;
  assert.throws(() => shapesOf(union), /a oneOf without a discriminator/);
});

test("LiveScope's variants are keyed by their kind, and a nullable type is kept nullable", () => {
  const shapes = shapesOf(openapi());
  const scope = shapes['improvement-pass.finished'].required.data.required.pass.required.scope;
  assert.equal(scope.kind, 'union');
  assert.deepEqual(Object.keys(scope.variants), ['tenant', 'org', 'project', 'segment']);
  assert.deepEqual(runFields(shapes).required.failureMessage, { kind: 'string', nullable: true });
});

test('an x- extension or another annotation-only keyword is skipped', () => {
  const doc = openapi();
  Object.assign(schemas(doc).RequestedApproval.properties.url, {
    'x-kindgi-note': 'console link',
    readOnly: true,
    example: 'https://console.acme.example/approvals/appr_1',
  });
  assert.equal(render(shapesOf(doc)), render(shapesOf(openapi())));
});

test("a pattern the checker can't compile fails the generation", () => {
  const doc = openapi();
  schemas(doc).ScopeSegment.properties.key.pattern = '^[a-z](?<!x';
  assert.throws(() => shapesOf(doc), /ScopeSegment\.key: pattern .* doesn't compile/);
});
