// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import java.util.concurrent.CompletionStage;

/**
 * A tool's code that answers later: a {@link CompletionStage} (a {@code CompletableFuture}, or a
 * Scala {@code Future} converted with {@code asJava}). When the call passes its deadline or its
 * caller goes away, a {@code CompletableFuture} it returned is cancelled.
 *
 * @param <I> the input type
 * @param <O> the output type
 */
@FunctionalInterface
public interface AsyncToolHandler<I, O> {
  /**
   * @param input the input, checked against the tool's input schema
   * @param ctx the call's context
   * @return the output, later
   * @throws Exception when the tool fails before it starts its work
   */
  CompletionStage<O> handle(I input, ToolContext ctx) throws Exception;
}
