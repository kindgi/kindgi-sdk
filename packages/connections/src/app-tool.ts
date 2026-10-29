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

/** What a pack gives one of the mail tools: its id, and whose mailbox it uses. */
export interface MailToolOptions extends AppToolOptions {
  /**
   * Whose mailbox: `'person'` (the default), the run's person's own, the
   * one they connected; `'company'`, the company's, which a tenant admin
   * connected by signing in as it. It's part of what the tool declares,
   * so an id you've published keeps its `as`: give a company mailbox its
   * own tool id (`acme.store-mail.get`).
   */
  readonly as?: MailboxOwner;
}

/** Whose mailbox a mail tool uses. */
export type MailboxOwner = 'person' | 'company';

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
