// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { CommandContext } from '../context.js';
import type { Rendered } from '../output.js';

/**
 * A leaf command handler. Returns either a rendered success payload or
 * a rendered error. The dispatcher writes stdout/stderr and picks an
 * exit code accordingly.
 */
export type CommandResult =
  | { readonly kind: 'ok'; readonly rendered: Rendered; readonly exitCode?: number }
  | { readonly kind: 'error'; readonly stderr: string; readonly exitCode: number };

export interface LeafCommand {
  readonly kind: 'leaf';
  readonly name: string;
  readonly description: string;
  readonly usage: string;
  /** Option spec merged with the global spec by the parser. */
  readonly optionSpec?: Readonly<Record<string, ParseArgsOption>>;
  readonly run: (ctx: CommandContext) => Promise<CommandResult>;
}

export interface GroupCommand {
  readonly kind: 'group';
  readonly name: string;
  readonly description: string;
  readonly subcommands: readonly Command[];
}

export type Command = LeafCommand | GroupCommand;

export type ParseArgsOption =
  | {
      type: 'string';
      multiple?: boolean;
      short?: string;
      default?: string;
      /** What the flag does, in one sentence: `--help` and the docs show it. */
      description?: string;
      /**
       * The value may be left out (`--push`, or `--push` before another
       * flag): the option is then `''`. Given, it's the next token or
       * `--push=<value>`.
       */
      optionalValue?: boolean;
    }
  | {
      type: 'boolean';
      multiple?: boolean;
      short?: string;
      default?: boolean;
      /** What the flag does, in one sentence: `--help` and the docs show it. */
      description?: string;
    };
