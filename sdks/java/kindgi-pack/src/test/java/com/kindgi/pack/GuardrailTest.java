// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
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

  /** The built-in checks, as {@code @kindgi/guardrails} lists them ({@code BUILT_IN_CHECKS} in its checks.ts). */
  private static List<String> builtInCheckIds() throws Exception {
    Path checks = Path.of("../../../packages/guardrails/src/checks.ts");
    assertThat(checks).as("@kindgi/guardrails' checks, from sdks/java/kindgi-pack").exists();
    String source = Files.readString(checks);
    Matcher block = Pattern.compile("const BUILT_IN_CHECKS\\b[^=]*=\\s*\\[(.*?)\\];", Pattern.DOTALL).matcher(source);
    assertThat(block.find()).as("checks.ts declares BUILT_IN_CHECKS as an array").isTrue();
    List<String> ids = new ArrayList<>();
    Matcher id = Pattern.compile("\\bid:\\s*'([^']+)'").matcher(block.group(1));
    while (id.find()) {
      ids.add(id.group(1));
    }
    assertThat(ids).as("BUILT_IN_CHECKS' ids").isNotEmpty();
    return ids;
  }

  @Test
  void theReservedCheckIdsAreTheBuiltInChecks() throws Exception {
    assertThat(Guardrail.RESERVED_CHECK_IDS).containsExactlyInAnyOrderElementsOf(builtInCheckIds());
  }

  @Test
  void aGuardrailCantShipItsCheckUnderABuiltInId() {
    assertThatThrownBy(() -> Guardrail.define("acme.cites").checkId("must-cite").onViolation("halt")
        .check((config, trace) -> CheckResult.pass()))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage("guardrail acme.cites: its check id \"must-cite\" is a built-in check's, and a pack can't replace"
            + " a built-in. Rename your check (checkId(\"<pack>.checks.must-cite\")).");
    // Defaulted: the guardrail's own id is its check id.
    assertThatThrownBy(() -> Guardrail.define("never-call-tool").onViolation("halt")
        .check((config, trace) -> CheckResult.pass()))
        .hasMessageContaining("its check id \"never-call-tool\" is a built-in check's")
        .hasMessageEndingWith(", or rename the guardrail.");
    // An async check goes through the same refusal.
    assertThatThrownBy(() -> Guardrail.define("acme.cites").checkId("tool-order").onViolation("halt")
        .asyncCheck((config, trace) -> CompletableFuture.completedFuture(CheckResult.pass())))
        .hasMessageContaining("its check id \"tool-order\" is a built-in check's");
    // The pack's own id is fine.
    Guardrail<Map<String, Object>> own = Guardrail.define("acme.cites").checkId("acme.checks.must-cite")
        .onViolation("halt").check((config, trace) -> CheckResult.pass());
    assertThat(own.checkId()).isEqualTo("acme.checks.must-cite");
  }
}
