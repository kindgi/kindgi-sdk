// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.service;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.kindgi.pack.Tool;
import java.time.Duration;
import java.util.Map;

/** Tools for the service's own tests (PackServiceTest). */
public final class Tools {
  /** Ignores its interrupt and runs on past the deadline. */
  public static final Tool<Map<String, Object>, Map<String, Object>> STUBBORN = Tool.define("acme.stubborn")
      .handler((input, ctx) -> {
        long until = System.nanoTime() + 400_000_000L;
        while (System.nanoTime() < until) {
          try {
            Thread.sleep(10);
          } catch (InterruptedException e) {
            // Ignored, on purpose.
          }
        }
        return Map.of();
      });

  /** Stops when the call is cancelled. */
  public static final Tool<Map<String, Object>, Map<String, Object>> POLITE = Tool.define("acme.polite")
      .handler((input, ctx) -> {
        ctx.cancellation().await(Duration.ofSeconds(10));
        ctx.cancellation().throwIfCancelled();
        return Map.of();
      });

  /** Returns a number JSON can't write. */
  public static final Tool<Map<String, Object>, Object> NAN = Tool.define("acme.nan")
      .output(Map.of("type", "object"))
      .handler((input, ctx) -> Map.of("x", Double.NaN));

  /** An input whose own constructor refuses 13. */
  public static final class Count {
    private final int count;

    @JsonCreator
    public Count(@JsonProperty("count") int count) {
      if (count == 13) {
        throw new IllegalArgumentException("unlucky");
      }
      this.count = count;
    }

    public int getCount() {
      return count;
    }
  }

  public static final Tool<Count, Map<String, Object>> TYPED = Tool.define("acme.typed")
      .input(Count.class)
      .handler((input, ctx) -> Map.of("count", input.getCount()));

  private Tools() {}
}
