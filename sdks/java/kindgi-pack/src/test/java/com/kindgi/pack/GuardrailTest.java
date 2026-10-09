// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;

/** A guardrail's check, run in a unit test with {@code evaluate}: as the service would run it. */
class GuardrailTest {
  record MinLength(int minLength) {}

  static final Guardrail<MinLength> MIN_LENGTH = Guardrail.define("acme.min-length")
      .onViolation("halt")
      .config(MinLength.class)
      .check((config, trace) -> (trace.output() == null ? "" : trace.output()).length() >= config.minLength()
          ? CheckResult.pass()
          : CheckResult.fail("too short"));

  static final Guardrail<MinLength> LATER = Guardrail.define("acme.later")
      .onViolation("log-only")
      .config(MinLength.class)
      .asyncCheck((config, trace) -> CompletableFuture.supplyAsync(
          () -> trace.toolCalls().size() >= config.minLength() ? CheckResult.pass() : CheckResult.fail("too few calls")));

  static final Guardrail<Map<String, Object>> THROWS = Guardrail.define("acme.throws")
      .onViolation("halt")
      .check((config, trace) -> {
        throw new IllegalStateException("broken rule");
      });

  @Test
  void evaluateRunsTheCheckWithTheConfigAsGiven() throws Exception {
    assertThat(MIN_LENGTH.evaluate(new MinLength(3), new RunTrace(Map.of("output", "abc"))).passed()).isTrue();
    CheckResult short_ = MIN_LENGTH.evaluate(new MinLength(4), new RunTrace(Map.of("output", "abc")));
    assertThat(short_.passed()).isFalse();
    assertThat(short_.reason()).isEqualTo("too short");
  }

  @Test
  void anAsyncCheckIsAwaited() throws Exception {
    RunTrace trace = new RunTrace(Map.of("toolCalls", List.of(Map.of("toolName", "acme.lookup"))));
    assertThat(LATER.evaluate(new MinLength(1), trace).passed()).isTrue();
    assertThat(LATER.evaluate(new MinLength(2), trace).reason()).isEqualTo("too few calls");
  }

  @Test
  void whatTheCheckThrowsIsThrown() {
    assertThatThrownBy(() -> THROWS.evaluate(Map.of(), new RunTrace(Map.of())))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage("broken rule");
  }
}
