// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProjectId, RunId, TenantId } from '@kindgi/types';

import type { TestCaseAnswer } from './test-case-binding.js';

/**
 * Caller-plugged check of a replay's answer against what a case of an
 * agent's test set expects of it (`TestCaseExpect.answer`). A judging
 * model reads the answer and says whether it passes:
 *
 * - `answer: right`: does it say what the recorded answer said;
 * - `answer: wrong`: does it do what `shouldSay` or `why` asks.
 *
 * The host plugs it into the comparison test run's dispatcher
 * (`CorrectedDispatcherOptions.answers`). Without it, a case's answer
 * isn't checked, and the answer adds no check. A check that throws fails
 * the test run; one that can't be made answers `unchecked` instead.
 */
export interface AnswerCheckBinding {
  check(input: AnswerCheckInput): Promise<AnswerCheck>;
}

/**
 * Whose model checks answers: an agent version's (the model its
 * model-settings block names), or a model named outright. One test run's
 * answers are all checked by the one model, so two runs judged by the
 * same one can be held to each other.
 */
export type TestRunJudging =
  | { readonly version: string }
  | { readonly model: { readonly providerId: string; readonly model: string } };

/** One repetition's answer to check. */
export interface AnswerCheckInput {
  readonly tenantId: TenantId;
  /** The test run's project: where the judging call is counted. */
  readonly projectId?: ProjectId;
  readonly testRunId: RunId;
  readonly caseId: string;
  /** The agent whose version ran, and whose version `judging` names. */
  readonly agentId: string;
  /** Whose model checks the answer. */
  readonly judging: TestRunJudging;
  /** The case's input: what the user asked. */
  readonly input: unknown;
  /** The recorded run's output: what the corrected run answered. */
  readonly recorded: unknown;
  /** The repetition's output: the answer to check. */
  readonly answer: unknown;
  /** What the case expects of the answer. */
  readonly expect: TestCaseAnswer;
}

/**
 * What the check found. `checked`: whether the answer passed, with the
 * judging model's reason when it gave one, and what the call cost
 * (counted in the test run's cost). `unchecked`: it couldn't be checked,
 * say because the version has no model settings, the call to the judging
 * model failed, or its reply couldn't be read (what that call cost still
 * counts); the answer then adds no check. Its `reason` says what's
 * missing, never quoting the case or its answer: the test run's summary
 * shows the first one (`unchecked.why`).
 */
export type AnswerCheck =
  | {
      readonly kind: 'checked';
      readonly pass: boolean;
      readonly why?: string;
      readonly costUsd?: number;
    }
  | { readonly kind: 'unchecked'; readonly reason: string; readonly costUsd?: number };
