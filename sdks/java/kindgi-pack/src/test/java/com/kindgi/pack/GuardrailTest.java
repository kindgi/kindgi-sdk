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
    // Each entry names its id as `builtIn('must-cite', …)`, or as an object's `id: 'must-cite'`.
    Matcher id = Pattern.compile("(?:\\bbuiltIn\\(\\s*|\\bid:\\s*)'([^']+)'").matcher(block.group(1));
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

  @Test
  void anLlmJudgeGuardrailNeedsItsJudge() {
    assertThatThrownBy(() -> Guardrail.define("acme.tone").kind("llm-judge").onViolation("halt")
        .check((config, trace) -> CheckResult.pass()))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageStartingWith("guardrail acme.tone is kind llm-judge with no judgeCapabilities: name what its judge"
            + " model is routed by");
    Map<String, Object> needs = Map.of("needs", List.of(Map.of("feature", "structured-output")));
    Guardrail<Map<String, Object>> judged = Guardrail.define("acme.tone").kind("llm-judge").judgeCapabilities(needs)
        .onViolation("halt").check((config, trace) -> CheckResult.pass());
    assertThat(judged.entry()).containsEntry("judgeCapabilities", needs);
  }

  static final Guardrail<Map<String, Object>> NO_GUARANTEES = Guardrail.define("acme.no-guarantees")
      .onViolation("halt")
      .builtInCheck("forbidden-substring", Map.of("patterns", List.of("guaranteed", "we promise")));

  @Test
  void aBuiltInCheckIsNamedWithItsConfig() {
    assertThat(NO_GUARANTEES.builtIn()).isTrue();
    assertThat(NO_GUARANTEES.checkId()).isEqualTo("forbidden-substring");
    assertThat(NO_GUARANTEES.configSchema()).isNull();
    assertThat(NO_GUARANTEES.entry()).containsEntry("kind", "zero-llm").containsEntry("checkBuiltIn", true)
        .containsEntry("config", Map.of("patterns", List.of("guaranteed", "we promise")));
    assertThat(MIN_LENGTH.builtIn()).isFalse();
    // Without a config, the built-in takes its defaults; a set("config", …) is the same as giving one.
    assertThat(Guardrail.define("acme.cites").onViolation("halt").builtInCheck("must-cite").entry())
        .doesNotContainKey("config");
    Map<String, Object> patterns = Map.of("patterns", List.of("guaranteed"));
    assertThat(Guardrail.define("acme.g").onViolation("halt").set("config", patterns)
        .builtInCheck("forbidden-substring").entry()).containsEntry("config", patterns);
  }

  @Test
  void aBuiltInRunsOnlyInTheRuntime() {
    assertThatThrownBy(() -> NO_GUARANTEES.evaluate(Map.of(), new RunTrace(Map.of())))
        .isInstanceOf(UnsupportedOperationException.class)
        .hasMessageStartingWith("guardrail acme.no-guarantees names the built-in check \"forbidden-substring\": the"
            + " Kindgi runtime runs it, not the Java SDK.");
  }

  @Test
  void aBuiltInCheckIsOneOfTheBuiltIns() {
    assertThatThrownBy(() -> Guardrail.define("acme.mine").onViolation("halt").builtInCheck("acme.checks.mine"))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessage("guardrail acme.mine: \"acme.checks.mine\" isn't a built-in check. The built-ins are"
            + " must-cite, never-call-tool, max-tool-calls, output-matches, tool-order, required-substring,"
            + " forbidden-substring; a check of your own is check(…).");
  }

  @Test
  void aBuiltInCheckRefusesWhatItDoesntTake() {
    Map<String, Object> patterns = Map.of("patterns", List.of("guaranteed"));
    assertThatThrownBy(() -> Guardrail.define("acme.g").builtInCheck("must-cite"))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage("guardrail acme.g: say what a failing check does (onViolation or action)");
    assertThatThrownBy(() -> Guardrail.define("acme.g").onViolation("halt").set("config", patterns)
        .builtInCheck("forbidden-substring", patterns))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage("guardrail acme.g: its config is given twice, by set(\"config\", …) and by builtInCheck(…,"
            + " config). Give it once.");
    assertThatThrownBy(() -> Guardrail.define("acme.g").onViolation("halt").config(MinLength.class)
        .builtInCheck("must-cite"))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage("guardrail acme.g: a built-in's config is the runtime's to check, so it takes no typed config or"
            + " config schema");
    assertThatThrownBy(() -> Guardrail.define("acme.g").onViolation("halt").configSchema(Map.of("type", "object"))
        .builtInCheck("must-cite"))
        .hasMessageContaining("takes no typed config or config schema");
    assertThatThrownBy(() -> Guardrail.define("acme.g").onViolation("halt").checkId("must-cite")
        .builtInCheck("must-cite"))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage("guardrail acme.g: builtInCheck names its check, so it takes no checkId(…)");
    assertThatThrownBy(() -> Guardrail.define("acme.g").onViolation("halt").kind("llm-judge")
        .builtInCheck("must-cite"))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage("guardrail acme.g: a built-in check is zero-llm, not llm-judge");
    assertThatThrownBy(() -> Guardrail.define("acme.g").onViolation("halt")
        .judgeCapabilities(Map.of("needs", List.of())).set("sandbox", "strict").set("network", Map.of())
        .builtInCheck("must-cite"))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage("guardrail acme.g: the runtime runs a built-in check, which takes no judgeCapabilities, sandbox,"
            + " network");
  }

  @Test
  void aBuiltInRunsWhereItCanAct() {
    // TypeScript's indexer refuses the same guardrails at build.
    Guardrail<Map<String, Object>> beforeTool = Guardrail.define("acme.g").onViolation("halt").set("at", "before-tool")
        .set("scope", Map.of("tools", List.of("acme.*")))
        .builtInCheck("never-call-tool", Map.of("tools", List.of("acme.refund")));
    assertThat(beforeTool.entry()).containsEntry("at", "before-tool");
    assertThat(Guardrail.define("acme.g").onViolation("escalate").builtInCheck("must-cite").entry())
        .doesNotContainKey("at");
    assertThatThrownBy(() -> Guardrail.define("acme.g").onViolation("halt").set("at", "before-answer")
        .builtInCheck("must-cite"))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage("guardrail acme.g: at must be one of before-tool, after-tool, model-step, final-answer");
    assertThatThrownBy(() -> Guardrail.define("acme.g").onViolation("escalate").set("at", "before-tool")
        .builtInCheck("never-call-tool"))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage("guardrail acme.g: \"escalate\" is recorded at the final answer only, not at \"before-tool\"");
    assertThatThrownBy(() -> Guardrail.define("acme.g").action(Map.of("on-violation", "compensate"))
        .set("at", "model-step").builtInCheck("max-tool-calls"))
        .hasMessageContaining("\"compensate\" is recorded at the final answer only, not at \"model-step\"");
    for (Object tools : List.of(List.of(), List.of("acme.*.refund"), List.of(""), "acme.refund")) {
      assertThatThrownBy(() -> Guardrail.define("acme.g").onViolation("halt").set("at", "before-tool")
          .set("scope", Map.of("tools", tools)).builtInCheck("never-call-tool"))
          .isInstanceOf(IllegalStateException.class)
          .hasMessage("guardrail acme.g: scope.tools must name one or more tool ids, each with at most a trailing '*'");
    }
    assertThatThrownBy(() -> Guardrail.define("acme.g").onViolation("halt")
        .set("scope", Map.of("tools", List.of("acme.*"))).builtInCheck("must-cite"))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage("guardrail acme.g: scope.tools is for \"before-tool\" and \"after-tool\", not \"final-answer\"");
  }
}
