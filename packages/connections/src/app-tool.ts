// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Tool, defineTool } from '@kindgi/tools';
import type { ToolId } from '@kindgi/types';

/** What a pack gives one of these tools when it includes it. */
export interface AppToolOptions {
  /**
   * The tool's id, namespaced by the pack like any of its own tools
   * (`acme.gmail.send`). There is no default: a tool id is the tenant's,
   * filed under the first project that publishes it, so a fixed id would
   * leave every other project unable to publish the tool.
   */
  readonly id: string;
}

/** The tool `spec` describes, under the pack's id. A spec or id that doesn't compile throws, naming the id. */
export function appTool<TInput, TOutput>(
  spec: Omit<Tool<TInput, TOutput>, 'id'>,
  options: AppToolOptions,
): Tool<TInput, TOutput> {
  const defined = defineTool<TInput, TOutput>({ ...spec, id: options.id as ToolId });
  if (defined.kind === 'err') {
    throw new Error(`The tool "${options.id}" failed to compile: ${defined.error.message}`);
  }
  return defined.value;
}
