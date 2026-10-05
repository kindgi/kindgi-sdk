// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { adaptersCommand } from './adapters.js';
import { agentsCommand } from './agents.js';
import { approvalsCommand } from './approvals.js';
import { artifactsCommand } from './artifacts.js';
import { authCommand } from './auth.js';
import { buildCommand } from './build.js';
import { capabilitiesCommand } from './capabilities.js';
import { conversationsCommand } from './conversations.js';
import { deployCommand } from './deploy.js';
import { devCommand } from './dev.js';
import { envCommand } from './env.js';
import { feedbackCommand } from './feedback.js';
import { flowsCommand } from './flows.js';
import { guardrailsCommand } from './guardrails.js';
import { healthCommand } from './health.js';
import { initCommand } from './init.js';
import { judgeClassesCommand } from './judge-classes.js';
import { judgmentsCommand } from './judgments.js';
import { keyCommand } from './key.js';
import { mcpCommand, mcpLaunchCommand } from './mcp.js';
import { memoryCommand } from './memory.js';
import { observationsCommand } from './observations.js';
import { proposalsCommand } from './proposals.js';
import { provenanceCommand } from './provenance.js';
import { providersCommand } from './providers.js';
import { reviewersCommand } from './reviewers.js';
import { runsCommand } from './runs.js';
import { secretsCommand } from './secrets.js';
import { skillsCommand } from './skills.js';
import { testCommand } from './test.js';
import { tokensCommand } from './tokens.js';
import { toolsCommand } from './tools.js';
import type { Command } from './types.js';
import { versionCommand } from './version.js';

export const ROOT_COMMANDS: readonly Command[] = [
  authCommand,
  initCommand,
  devCommand,
  buildCommand,
  deployCommand,
  testCommand,
  envCommand,
  secretsCommand,
  keyCommand,
  mcpCommand,
  mcpLaunchCommand,
  runsCommand,
  agentsCommand,
  conversationsCommand,
  toolsCommand,
  guardrailsCommand,
  memoryCommand,
  proposalsCommand,
  provenanceCommand,
  artifactsCommand,
  flowsCommand,
  approvalsCommand,
  reviewersCommand,
  observationsCommand,
  judgmentsCommand,
  judgeClassesCommand,
  tokensCommand,
  capabilitiesCommand,
  providersCommand,
  adaptersCommand,
  skillsCommand,
  feedbackCommand,
  healthCommand,
  versionCommand,
];

export function findCommand(
  tokens: readonly string[],
): { command: Command; consumed: number } | null {
  if (tokens.length === 0) return null;
  const [first, ...rest] = tokens;
  const top = ROOT_COMMANDS.find((c) => c.name === first);
  if (top === undefined) return null;
  if (top.kind === 'leaf') return { command: top, consumed: 1 };
  return descend(top, rest, 1);
}

function descend(
  group: Extract<Command, { kind: 'group' }>,
  tokens: readonly string[],
  consumedSoFar: number,
): { command: Command; consumed: number } {
  if (tokens.length === 0) return { command: group, consumed: consumedSoFar };
  const [first, ...rest] = tokens;
  const child = group.subcommands.find((c) => c.name === first);
  if (child === undefined) return { command: group, consumed: consumedSoFar };
  if (child.kind === 'leaf') return { command: child, consumed: consumedSoFar + 1 };
  return descend(child, rest, consumedSoFar + 1);
}
