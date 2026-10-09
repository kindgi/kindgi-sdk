// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.jspecify.annotations.Nullable;

/**
 * Whether the call was cancelled: past its deadline, or its caller went away. The service also
 * interrupts the handler's thread, so a blocking wait ends at once; a handler that loops checks
 * {@link #isCancelled()} or {@link #throwIfCancelled()}.
 */
public final class Cancellation {
  private final CountDownLatch cancelled = new CountDownLatch(1);
  private volatile @Nullable String reason;

  /** A cancellation that hasn't fired. */
  public Cancellation() {}

  /** @return whether the call was cancelled */
  public boolean isCancelled() {
    return cancelled.getCount() == 0;
  }

  /** @return why: {@code deadline-exceeded} or {@code cancelled}; {@code null} until then */
  public @Nullable String reason() {
    return reason;
  }

  /**
   * @throws CancelledException when the call was cancelled
   */
  public void throwIfCancelled() {
    if (isCancelled()) {
      throw new CancelledException(reason);
    }
  }

  /**
   * Waits until the call is cancelled, or for {@code timeout}.
   *
   * @param timeout the longest wait
   * @return whether it was cancelled
   * @throws InterruptedException when the thread is interrupted
   */
  public boolean await(Duration timeout) throws InterruptedException {
    return cancelled.await(timeout.toMillis(), TimeUnit.MILLISECONDS);
  }

  /** Fires the cancellation (the service does, at the deadline or when the caller goes away). */
  void cancel(String why) {
    if (reason == null) {
      reason = why;
    }
    cancelled.countDown();
  }

  /** The call was cancelled; a handler may let it propagate. */
  public static final class CancelledException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    CancelledException(@Nullable String reason) {
      super("cancelled: " + reason);
    }
  }
}
