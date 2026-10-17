// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import org.jspecify.annotations.Nullable;

/** An async handler's answer, awaited on the call's thread: its failure is the handler's. */
final class Awaiting {
  private Awaiting() {}

  /**
   * @param stage what the handler returned
   * @param cancellation the call's: firing it cancels a {@code CompletableFuture}
   * @return the answer
   * @throws Exception what the handler's work failed with; {@code InterruptedException} when the
   *     waiting thread is interrupted (the future is cancelled)
   */
  static <T> T await(@Nullable CompletionStage<T> stage, @Nullable Cancellation cancellation) throws Exception {
    if (stage == null) {
      throw new IllegalStateException("the handler returned no CompletionStage (null)");
    }
    CompletableFuture<T> future = stage.toCompletableFuture();
    if (cancellation != null) {
      cancellation.onCancel(() -> future.cancel(true));
    }
    try {
      return future.get();
    } catch (InterruptedException e) {
      // The service stopped waiting (its deadline, its drain): nobody will read the answer.
      future.cancel(true);
      throw e;
    } catch (ExecutionException e) {
      Throwable cause = e.getCause() == null ? e : e.getCause();
      if (cause instanceof Exception) {
        throw (Exception) cause;
      }
      throw (Error) cause;
    } catch (CancellationException e) {
      if (cancellation != null) {
        cancellation.throwIfCancelled();
      }
      throw e;
    }
  }
}
