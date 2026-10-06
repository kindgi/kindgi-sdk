// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Each name the published types once exported twice now means the
 * client's own type: `dist/index.d.ts`'s `Fact` is `src`'s `Fact`, not
 * an inlined namesake. Needs a prior `pnpm run build`.
 */

import { describe, expectTypeOf, test } from 'vitest';

import type * as Dist from '../dist/index.js';
import type * as Src from '../src/index.js';

describe("the published name is the client's own type", () => {
  test('ConversationMessage', () => {
    expectTypeOf<Dist.ConversationMessage>().toEqualTypeOf<Src.ConversationMessage>();
  });
  test('EvaluationResult', () => {
    expectTypeOf<Dist.EvaluationResult>().toEqualTypeOf<Src.EvaluationResult>();
  });
  test('Fact', () => {
    expectTypeOf<Dist.Fact>().toEqualTypeOf<Src.Fact>();
  });
  test('GeneratedWebhookSecret', () => {
    expectTypeOf<Dist.GeneratedWebhookSecret>().toEqualTypeOf<Src.GeneratedWebhookSecret>();
  });
  test('MessageRole', () => {
    expectTypeOf<Dist.MessageRole>().toEqualTypeOf<Src.MessageRole>();
  });
  test('ProvidersClient', () => {
    expectTypeOf<Dist.ProvidersClient>().toEqualTypeOf<Src.ProvidersClient>();
  });
  test('ReviewerRole', () => {
    expectTypeOf<Dist.ReviewerRole>().toEqualTypeOf<Src.ReviewerRole>();
  });
  test('RevokeSigningKeyResult', () => {
    expectTypeOf<Dist.RevokeSigningKeyResult>().toEqualTypeOf<Src.RevokeSigningKeyResult>();
  });
  test('RunFinishedEvent', () => {
    expectTypeOf<Dist.RunFinishedEvent>().toEqualTypeOf<Src.RunFinishedEvent>();
  });
  test('TrustedSigningKey', () => {
    expectTypeOf<Dist.TrustedSigningKey>().toEqualTypeOf<Src.TrustedSigningKey>();
  });
  test('WebhookDelivery', () => {
    expectTypeOf<Dist.WebhookDelivery>().toEqualTypeOf<Src.WebhookDelivery>();
  });
  test('WebhookDeliveryStatus', () => {
    expectTypeOf<Dist.WebhookDeliveryStatus>().toEqualTypeOf<Src.WebhookDeliveryStatus>();
  });
  test('WebhookEndpoint', () => {
    expectTypeOf<Dist.WebhookEndpoint>().toEqualTypeOf<Src.WebhookEndpoint>();
  });
  test('WebhookEvent', () => {
    expectTypeOf<Dist.WebhookEvent>().toEqualTypeOf<Src.WebhookEvent>();
  });
  test('WebhookSecretRef', () => {
    expectTypeOf<Dist.WebhookSecretRef>().toEqualTypeOf<Src.WebhookSecretRef>();
  });
  test('WebhookTestEvent', () => {
    expectTypeOf<Dist.WebhookTestEvent>().toEqualTypeOf<Src.WebhookTestEvent>();
  });
});
