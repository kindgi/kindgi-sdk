// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { adaptersCommand } from './adapters.js';
import { agentsCommand } from './agents.js';
import { approvalsCommand } from './approvals.js';
import { artifactsCommand } from './artifacts.js';
import { authCommand } from './auth.js';
import { blocksCommand } from './blocks.js';
import { buildCommand } from './build.js';
import { capabilitiesCommand } from './capabilities.js';
import { connectionAppsCommand } from './connection-apps.js';
import { connectionsCommand } from './connections.js';
import { consoleCommand } from './console.js';
import { conversationsCommand } from './conversations.js';
import { correctionsCommand } from './corrections.js';
import { correctorGroupsCommand } from './corrector-groups.js';
import { deployCommand } from './deploy.js';
import { deploymentsCommand } from './deployments.js';
import { devCommand } from './dev.js';
import { doctorCommand } from './doctor.js';
import { egressCommand } from './egress.js';
import { envCommand } from './env.js';
import { environmentsCommand } from './environments.js';
import { evalRunsCommand } from './eval-runs.js';
import { expertQueueCommand } from './expert-queue.js';
import { exportsCommand } from './exports.js';
import { feedbackCommand } from './feedback.js';
import { flowsCommand } from './flows.js';
import { gatePoliciesCommand } from './gate-policies.js';
import { guardrailsCommand } from './guardrails.js';
import { healthCommand } from './health.js';
import { initCommand } from './init.js';
import { keyCommand } from './key.js';
import { licenseCommand } from './license.js';
import { mailTriggersCommand } from './mail-triggers.js';
import { mcpCommand, mcpLaunchCommand } from './mcp.js';
import { memoryCommand } from './memory.js';
import { observationsCommand } from './observations.js';
import { peopleCommand } from './people.js';
import { projectsCommand } from './projects.js';
import { promoteCommand } from './promote.js';
import { proposalsCommand } from './proposals-improve.js';
import { provenanceCommand } from './provenance.js';
import { providersCommand } from './providers.js';
import { queueRulesCommand } from './queue-rules.js';
import { reviewersCommand } from './reviewers.js';
import { runsCommand } from './runs.js';
import { schedulesCommand } from './schedules.js';
import { secretsCommand } from './secrets.js';
import { serviceAccountsCommand } from './service-accounts.js';
import { signInCommand } from './sign-in.js';
import { sitesCommand } from './sites.js';
import { skillsCommand } from './skills.js';
import { ssoCommand } from './sso.js';
import { suggestedChangesCommand } from './suggested-changes.js';
import { tenantCommand } from './tenant.js';
import { testSetsCommand } from './test-sets.js';
import { testCommand } from './test.js';
import { tokensCommand } from './tokens.js';
import { toolsCommand } from './tools.js';
import type { Command } from './types.js';
import { upgradeCommand } from './upgrade.js';
import { usageCommand } from './usage.js';
import { versionCommand } from './version.js';
import { webhooksCommand } from './webhooks.js';

export const ROOT_COMMANDS: readonly Command[] = [
  authCommand,
  initCommand,
  upgradeCommand,
  devCommand,
  consoleCommand,
  buildCommand,
  deployCommand,
  deploymentsCommand,
  promoteCommand,
  testCommand,
  envCommand,
  environmentsCommand,
  secretsCommand,
  connectionsCommand,
  connectionAppsCommand,
  ssoCommand,
  signInCommand,
  sitesCommand,
  keyCommand,
  licenseCommand,
  mcpCommand,
  mcpLaunchCommand,
  projectsCommand,
  tenantCommand,
  runsCommand,
  agentsCommand,
  conversationsCommand,
  toolsCommand,
  guardrailsCommand,
  memoryCommand,
  proposalsCommand,
  suggestedChangesCommand,
  provenanceCommand,
  exportsCommand,
  artifactsCommand,
  flowsCommand,
  schedulesCommand,
  webhooksCommand,
  mailTriggersCommand,
  approvalsCommand,
  reviewersCommand,
  observationsCommand,
  correctionsCommand,
  correctorGroupsCommand,
  queueRulesCommand,
  expertQueueCommand,
  evalRunsCommand,
  testSetsCommand,
  blocksCommand,
  gatePoliciesCommand,
  tokensCommand,
  serviceAccountsCommand,
  peopleCommand,
  usageCommand,
  capabilitiesCommand,
  providersCommand,
  adaptersCommand,
  skillsCommand,
  feedbackCommand,
  egressCommand,
  healthCommand,
  doctorCommand,
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
