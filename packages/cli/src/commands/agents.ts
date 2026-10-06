// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentId } from '@kindgi/types';

import {
  listFlag,
  projectIdFlag,
  readJsonInput,
  requiredPositional,
  runSdk,
  stringFlag,
  throwUnwired,
} from './helpers.js';
import type { Command, LeafCommand } from './types.js';

// Re-declared locally to avoid pulling `@kindgi/agents` into the CLI's
// dep tree — the SDK re-exports the same shape when it fills the
// `agents.define` transport body.
type AgentDefinitionSpec = Parameters<import('@kindgi/client').KindgiClient['agents']['define']>[0];

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List registered agents.',
  usage: 'kindgi agents list [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    limit: { type: 'string', description: 'The most agents to return.' },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) => runSdk(ctx, 'agents list', async () => throwUnwired('agents.list')),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch a registered agent by id.',
  usage: 'kindgi agents get <agent-id>',
  run: (ctx) =>
    runSdk(ctx, 'agents get', async () => {
      requiredPositional(ctx, 0, 'agent-id');
      throwUnwired('agents.get');
    }),
};

const publish: LeafCommand = {
  kind: 'leaf',
  name: 'publish',
  description: 'Register an agent definition.',
  usage: 'kindgi agents publish --spec=<json-or-@file> [--project=<project-id>]',
  optionSpec: {
    spec: {
      type: 'string',
      description: 'The agent definition as JSON, or `@<file>` to read it from a file. Required.',
    },
    project: {
      type: 'string',
      description:
        "The project to register the agent in, by id (default: the tenant's Default project).",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'agents publish', async () => {
      const specText = stringFlag(ctx, 'spec');
      if (specText === undefined) throw new Error('--spec=<json-or-@file> is required');
      const spec = (await readJsonInput(specText)) as AgentDefinitionSpec;
      const projectId = await projectIdFlag(ctx);
      const agentId = await ctx.client().agents.define(spec, { projectId });
      return { agentId };
    }),
};

const unregister: LeafCommand = {
  kind: 'leaf',
  name: 'unregister',
  description: 'Unregister a specific agent version.',
  usage: 'kindgi agents unregister <agent-id> --version=<semver>',
  optionSpec: {
    version: { type: 'string', description: 'The agent version to unregister (semver).' },
  },
  run: (ctx) =>
    runSdk(ctx, 'agents unregister', async () => {
      requiredPositional(ctx, 0, 'agent-id');
      throwUnwired('agents.unregister');
    }),
};

const versions: LeafCommand = {
  kind: 'leaf',
  name: 'versions',
  description: 'List published versions of an agent.',
  usage: 'kindgi agents versions <agent-id>',
  run: (ctx) =>
    runSdk(ctx, 'agents versions', async () => {
      requiredPositional(ctx, 0, 'agent-id');
      throwUnwired('agents.versions');
    }),
};

/** `--prompt` / `--setting` values (`<block-id>=<version>`), as a pin map. */
function pinSwaps(values: readonly string[], flag: string): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const value of values) {
    const at = value.indexOf('=');
    if (at <= 0 || at === value.length - 1) {
      throw new Error(`--${flag} takes <block-id>=<version>, got '${value}'`);
    }
    pins[value.slice(0, at)] = value.slice(at + 1);
  }
  return pins;
}

const derive: LeafCommand = {
  kind: 'leaf',
  name: 'derive',
  description:
    'Publish a new agent version from a pinned one with some prompt or settings pins swapped (no code change).',
  usage:
    'kindgi agents derive <agent-id> --from=<semver> [--prompt=<block-id>=<version>]... [--setting=<block-id>=<version>]... [--label=<text>] [--project=<project-id>]',
  optionSpec: {
    from: {
      type: 'string',
      description: 'The agent version to derive from; it must be pinned. Required.',
    },
    prompt: {
      type: 'string',
      multiple: true,
      description:
        'Pin a prompt block the version already uses to this version (`<block-id>=<version>`). Repeat for several.',
    },
    setting: {
      type: 'string',
      multiple: true,
      description:
        'Pin a settings block the version already uses to this version (`<block-id>=<version>`). Repeat for several.',
    },
    label: { type: 'string', description: 'A short label for the new version.' },
    project: {
      type: 'string',
      description:
        "The agent's project, by id; only needed when the runtime doesn't record it on the version.",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'agents derive', async () => {
      const agentId = requiredPositional(ctx, 0, 'agent-id');
      const from = stringFlag(ctx, 'from');
      if (from === undefined) throw new Error('--from=<semver> is required');
      const prompts = pinSwaps(listFlag(ctx, 'prompt'), 'prompt');
      const settings = pinSwaps(listFlag(ctx, 'setting'), 'setting');
      if (Object.keys(prompts).length + Object.keys(settings).length === 0) {
        throw new Error(
          'Name at least one pin to swap: --prompt=<id>=<version> or --setting=<id>=<version>',
        );
      }
      const label = stringFlag(ctx, 'label');
      const projectId = stringFlag(ctx, 'project');
      return await ctx.client().agents.versions.derive(agentId as AgentId, {
        from,
        pins: {
          ...(Object.keys(prompts).length > 0 && { prompts }),
          ...(Object.keys(settings).length > 0 && { settings }),
        },
        ...(label !== undefined && { label }),
        ...(projectId !== undefined && { projectId }),
      });
    }),
};

export const agentsCommand: Command = {
  kind: 'group',
  name: 'agents',
  description: 'Manage agent registrations.',
  subcommands: [list, get, publish, derive, unregister, versions],
};
