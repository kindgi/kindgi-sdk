// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expectTypeOf, it } from 'vitest';

import type {
  ConnectFinish,
  ConnectInput,
  ConnectionCandidate,
  ConnectionChoice,
  ListConnectionChoicesInput,
  SetConnectionChoiceInput,
} from '../../src/index.js';

describe('connections — the connection a connect reconnects', () => {
  it('a connect may name the connection it reconnects', () => {
    expectTypeOf<ConnectInput>().toHaveProperty('reconnects').toEqualTypeOf<string | undefined>();
  });

  it('the finish answer may say it reconnected, and the name it was to get', () => {
    expectTypeOf<ConnectFinish>()
      .toHaveProperty('reconnected')
      .toEqualTypeOf<boolean | undefined>();
    expectTypeOf<ConnectFinish>().toHaveProperty('labelTaken').toEqualTypeOf<string | undefined>();
  });
});

describe('connectionChoices — what a choice names', () => {
  it("a choice's list needs its project", () => {
    expectTypeOf<ListConnectionChoicesInput>().toHaveProperty('projectId').toEqualTypeOf<string>();
  });

  it('a choice is for an agent or a flow, at a version', () => {
    expectTypeOf<SetConnectionChoiceInput>()
      .toHaveProperty('agentId')
      .toEqualTypeOf<string | undefined>();
    expectTypeOf<SetConnectionChoiceInput>()
      .toHaveProperty('flowId')
      .toEqualTypeOf<string | undefined>();
    expectTypeOf<ConnectionChoice>().toHaveProperty('version').toEqualTypeOf<number>();
  });

  it("a candidate's app, account and state may be left out, as for a member", () => {
    expectTypeOf<ConnectionCandidate>().toHaveProperty('name').toEqualTypeOf<string>();
    expectTypeOf<ConnectionCandidate>().toHaveProperty('app').toEqualTypeOf<string | undefined>();
    expectTypeOf<ConnectionCandidate>()
      .toHaveProperty('accountLabel')
      .toEqualTypeOf<string | undefined>();
  });
});
