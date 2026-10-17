// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

/**
 * A tool's code: its input, already checked against the tool's input schema (defaults filled
 * in) and bound to its input type, and the call's context; it answers the output.
 *
 * @param <I> the input type
 * @param <O> the output type
 */
@FunctionalInterface
public interface ToolHandler<I, O> {
  /**
   * @param input the input
   * @param ctx the call's context
   * @return the output, checked against the tool's output schema
   * @throws Exception any failure: the call answers {@code handler-throw}, with its message
   */
  O handle(I input, ToolContext ctx) throws Exception;
}
