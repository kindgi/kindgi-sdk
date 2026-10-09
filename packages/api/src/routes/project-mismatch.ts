// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import type { ProjectId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { AppEnv } from '../types.js';

/** The kinds whose ids belong to the project their first version went to, and never move. */
export type ProjectBoundKind = 'agent' | 'flow' | 'tool' | 'eval-suite';

const NOUN: Readonly<Record<ProjectBoundKind, string>> = {
  agent: 'Agent',
  flow: 'Flow',
  tool: 'Tool',
  'eval-suite': 'Eval suite',
};

const ID_FIELD: Readonly<Record<ProjectBoundKind, string>> = {
  agent: 'agentId',
  flow: 'flowId',
  tool: 'toolId',
  'eval-suite': 'suiteId',
};

/**
 * `409 <kind>-project-mismatch`: the id belongs to another project than
 * the one given, and never moves (as a block's versions stay in its
 * project). The project it belongs to stays off the wire, so a caller who
 * can't read that project doesn't learn it; the request's log keeps it.
 */
export function projectMismatch(
  c: Context<AppEnv>,
  kind: ProjectBoundKind,
  id: string,
  owner: ProjectId,
  verb: 'publish' | 'derive' | 'build' = 'publish',
) {
  c.get('log').info(`${NOUN[kind]} "${id}" belongs to another project: ${verb} refused`, {
    [ID_FIELD[kind]]: id,
    ownerProjectId: owner as unknown as string,
  });
  c.status(statusFor(`${kind}-project-mismatch`) as never);
  return c.json(
    toWireError(
      {
        code: `${kind}-project-mismatch`,
        message: `${NOUN[kind]} "${id}" belongs to another project; ${verb} its versions there`,
        [ID_FIELD[kind]]: id,
      },
      c.get('requestId'),
    ),
  );
}
