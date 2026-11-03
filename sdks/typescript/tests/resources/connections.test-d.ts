// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expectTypeOf, it } from 'vitest';

import type {
  ConnectFinish,
  ConnectInput,
  Connection,
  ConnectionCandidate,
  ConnectionChoice,
  ConnectionChoicePage,
  ConnectionChoicesClient,
  ConnectionsClient,
  ListConnectionCandidatesInput,
  ListConnectionChoicesInput,
  SetConnectionChoiceInput,
  UpdateConnectionInput,
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

  it("the finish answer may say what another account's connect did to the person's main", () => {
    expectTypeOf<NonNullable<ConnectFinish['main']>>()
      .toHaveProperty('state')
      .toEqualTypeOf<'set' | 'kept' | 'missing'>();
    expectTypeOf<NonNullable<ConnectFinish['main']>>()
      .toHaveProperty('connectionId')
      .toEqualTypeOf<string | undefined>();
  });
});

describe("connections — a person's main connection", () => {
  it('an update is a label or `main`, each optional', () => {
    expectTypeOf<UpdateConnectionInput>()
      .toHaveProperty('label')
      .toEqualTypeOf<string | undefined>();
    expectTypeOf<UpdateConnectionInput>()
      .toHaveProperty('main')
      .toEqualTypeOf<boolean | undefined>();
    expectTypeOf<{ main: true }>().toMatchTypeOf<UpdateConnectionInput>();
  });

  it('a connection and a candidate say only that it is main', () => {
    expectTypeOf<Connection>().toHaveProperty('main').toEqualTypeOf<boolean | undefined>();
    expectTypeOf<ConnectionCandidate>().toHaveProperty('main').toEqualTypeOf<boolean | undefined>();
  });

  it("a connection's choices are a page of choices", () => {
    type Choices = Awaited<ReturnType<ConnectionsClient['choices']>>;
    expectTypeOf<Choices>().toEqualTypeOf<ConnectionChoicePage>();
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

  it("a choice's removal is there only once it's removed", () => {
    expectTypeOf<ListConnectionChoicesInput>()
      .toHaveProperty('includeRemoved')
      .toEqualTypeOf<boolean | undefined>();
    expectTypeOf<ConnectionChoice>()
      .toHaveProperty('removedAt')
      .toEqualTypeOf<string | undefined>();
    expectTypeOf<ConnectionChoice>()
      .toHaveProperty('removedBy')
      .toEqualTypeOf<string | undefined>();
  });

  it("a candidate's app, account and state may be left out, as for a member", () => {
    expectTypeOf<ConnectionCandidate>().toHaveProperty('name').toEqualTypeOf<string>();
    expectTypeOf<ConnectionCandidate>().toHaveProperty('app').toEqualTypeOf<string | undefined>();
    expectTypeOf<ConnectionCandidate>()
      .toHaveProperty('accountLabel')
      .toEqualTypeOf<string | undefined>();
  });

  it("the list and the candidates may keep to the caller's own; the list to one tool's", () => {
    expectTypeOf<ListConnectionChoicesInput>()
      .toHaveProperty('owner')
      .toEqualTypeOf<'me' | undefined>();
    expectTypeOf<ListConnectionChoicesInput>()
      .toHaveProperty('toolId')
      .toEqualTypeOf<string | undefined>();
    expectTypeOf<ListConnectionCandidatesInput>()
      .toHaveProperty('owner')
      .toEqualTypeOf<'me' | undefined>();
  });

  it("a choice may be a tool's, a set, and a person's own", () => {
    expectTypeOf<SetConnectionChoiceInput>()
      .toHaveProperty('toolId')
      .toEqualTypeOf<string | undefined>();
    expectTypeOf<SetConnectionChoiceInput>()
      .toHaveProperty('need')
      .toEqualTypeOf<string | undefined>();
    expectTypeOf<SetConnectionChoiceInput>()
      .toHaveProperty('connectionIds')
      .toEqualTypeOf<string[] | undefined>();
    expectTypeOf<SetConnectionChoiceInput>()
      .toHaveProperty('person')
      .toEqualTypeOf<{ userId: string } | undefined>();
    expectTypeOf<ConnectionChoice>().toHaveProperty('toolId').toEqualTypeOf<string | undefined>();
    expectTypeOf<ConnectionChoice>()
      .toHaveProperty('connectionIds')
      .toEqualTypeOf<string[] | undefined>();
    expectTypeOf<ConnectionChoice>()
      .toHaveProperty('person')
      .toEqualTypeOf<{ userId: string } | undefined>();
  });

  it("a need says whose connection it is, and why a set isn't allowed when it isn't", () => {
    type Needs = Awaited<ReturnType<ConnectionChoicesClient['needs']>>;
    expectTypeOf<Needs>().toHaveProperty('unread').toEqualTypeOf<string[] | undefined>();
    expectTypeOf<Needs['data'][number]>()
      .toHaveProperty('as')
      .toEqualTypeOf<'company' | 'person'>();
    expectTypeOf<Needs['data'][number]['set']>()
      .toHaveProperty('reason')
      .toEqualTypeOf<'changes' | 'sensitive-data-egress' | 'accounts-input' | undefined>();
    expectTypeOf<Parameters<ConnectionChoicesClient['needs']>[0]>()
      .toHaveProperty('projectId')
      .toEqualTypeOf<string>();
  });
});
