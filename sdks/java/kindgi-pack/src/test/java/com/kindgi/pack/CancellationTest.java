// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/** {@link Cancellation#onCancel}: each action runs once, when the call is cancelled or at once after. */
class CancellationTest {
  @Test
  void actionsRunWhenCancelledAndOnlyOnce() {
    Cancellation c = new Cancellation();
    List<String> ran = new CopyOnWriteArrayList<>();
    c.onCancel(() -> ran.add("first"));
    c.onCancel(() -> ran.add("second"));
    assertThat(ran).isEmpty();
    c.cancel("deadline-exceeded");
    c.cancel("cancelled");
    assertThat(ran).containsExactly("first", "second");
    assertThat(c.reason()).isEqualTo("deadline-exceeded");
  }

  @Test
  void anActionAddedAfterTheCancellationRunsAtOnce() {
    Cancellation c = new Cancellation();
    c.cancel("cancelled");
    AtomicInteger ran = new AtomicInteger();
    c.onCancel(ran::incrementAndGet);
    assertThat(ran).hasValue(1);
  }

  @Test
  void aFailingActionDoesntStopTheOthers() {
    Cancellation c = new Cancellation();
    AtomicInteger ran = new AtomicInteger();
    c.onCancel(() -> {
      throw new IllegalStateException("boom");
    });
    c.onCancel(ran::incrementAndGet);
    c.cancel("cancelled");
    assertThat(ran).hasValue(1);
  }

  @Test
  void racingTheCancellationStillRunsEachActionOnce() throws Exception {
    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      for (int round = 0; round < 500; round++) {
        Cancellation c = new Cancellation();
        AtomicInteger ran = new AtomicInteger();
        CountDownLatch go = new CountDownLatch(1);
        var adding = pool.submit(() -> {
          go.await();
          c.onCancel(ran::incrementAndGet);
          return null;
        });
        var cancelling = pool.submit(() -> {
          go.await();
          c.cancel("cancelled");
          return null;
        });
        go.countDown();
        adding.get(5, TimeUnit.SECONDS);
        cancelling.get(5, TimeUnit.SECONDS);
        assertThat(ran).as("round %d", round).hasValue(1);
      }
    } finally {
      pool.shutdownNow();
    }
  }
}
