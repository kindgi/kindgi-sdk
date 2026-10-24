// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.kindgi.log.Logger;
import com.kindgi.pack.internal.Json;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The {@code needsSpec} definition-time check ({@link Needs#check}) and the {@code needsSpec.env}
 * test-context fill ({@link ToolContext#forTest(Tool, Map, Map)}), matching the TypeScript
 * {@code @kindgi/tools}.
 */
class NeedsSpecTest {
  // --- Definition-time check (Needs.check) --------------------------------------------------

  @Test
  void acceptsValidEnvAndSecrets() {
    Map<String, Object> needsSpec = Map.of(
        "secrets", Map.of(
            "SIGNING_KEY", Map.of("type", "string", "minLength", 32),
            "STAMP_KEY", Map.of("type", java.util.List.of("string", "null"), "minLength", 32)),
        "env", Map.of("REGION", Map.of("type", "string", "enum", java.util.List.of("eu", "us"), "default", "eu")));
    assertThat(Needs.check("acme.sign", needsSpec)).isNull();
  }

  @Test
  void rejectsASecretSchemaThatDoesNotCompile() {
    Map<String, Object> needsSpec = Map.of(
        "secrets", Map.of("SIGNING_KEY", Map.of("type", "string", "x-unknown", true)));
    assertThat(Needs.check("acme.sign", needsSpec))
        .contains("/needsSpec/secrets/SIGNING_KEY")
        .contains("the schema doesn't compile:");
  }

  @Test
  void rejectsAnEnvSchemaThatDoesNotCompile() {
    Map<String, Object> needsSpec = Map.of("env", Map.of("REGION", Map.of("type", "strng")));
    assertThat(Needs.check("acme.sign", needsSpec))
        .contains("/needsSpec/env/REGION")
        .contains("the schema doesn't compile:");
  }

  @Test
  void rejectsAnEnvDefaultThatIsNotAString() {
    Map<String, Object> needsSpec = Map.of("env", Map.of("RETRIES", Map.of("type", "string", "default", 3)));
    assertThat(Needs.check("acme.sign", needsSpec))
        .isEqualTo("tool 'acme.sign' is invalid at /needsSpec/env/RETRIES/default: "
            + "the default must be a string: env values are strings");
  }

  @Test
  @SuppressWarnings("unchecked")
  void aNullEnvDefaultIsNoDefault() {
    Map<String, Object> region = new HashMap<>();
    region.put("type", "string");
    region.put("default", null);
    Tool<?, ?> tool = toolWithEnv(Map.of("REGION", region));
    // What the indexer checks and writes: needsSpec as a plain value, which drops the null default.
    Map<String, Object> needsSpec = (Map<String, Object>) Json.plain(tool.extra().get("needsSpec"));
    assertThat(((Map<String, Map<String, Object>>) needsSpec.get("env")).get("REGION")).isEqualTo(Map.of("type", "string"));
    assertThat(Needs.check("acme.env", needsSpec)).isNull();
    // So the name has no default: a test must set it, as a run must.
    assertThatThrownBy(() -> ToolContext.forTest(tool, Map.of(), null))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("needs env value \"REGION\"");
  }

  @Test
  void checksSecretsBeforeEnv() {
    Map<String, Object> needsSpec = Map.of(
        "secrets", Map.of("KEY", Map.of("type", "secrit")),
        "env", Map.of("REGION", Map.of("type", "strng")));
    assertThat(Needs.check("acme.sign", needsSpec)).contains("/needsSpec/secrets/KEY");
  }

  @Test
  void leavesConfigCapabilitiesAndBindingsAlone() {
    Map<String, Object> needsSpec = Map.of(
        "config", Map.of("BAD", Map.of("type", "strng")),
        "capabilities", java.util.List.of("read"),
        "bindings", java.util.List.of("db:ledger"));
    assertThat(Needs.check("acme.sign", needsSpec)).isNull();
  }

  @Test
  void leavesANonObjectNeedsSpecToTheSchema() {
    assertThat(Needs.check("acme.sign", "not a map")).isNull();
    assertThat(Needs.check("acme.sign", null)).isNull();
  }

  // --- Test-context fill (ToolContext.forTest(tool, env, secrets)) --------------------------

  private static Tool<Map<String, Object>, Map<String, Object>> toolWithEnv(Map<String, Object> env) {
    return Tool.define("acme.env").set("needsSpec", Map.of("env", env)).handler((input, ctx) -> input);
  }

  @Test
  void fillsAStringDefault() {
    Tool<?, ?> tool = toolWithEnv(Map.of("REGION", Map.of("type", "string", "default", "eu")));
    assertThat(ToolContext.forTest(tool, Map.of(), null).env()).isEqualTo(Map.of("REGION", "eu"));
  }

  @Test
  void aGivenValueWinsOverTheDefault() {
    Tool<?, ?> tool = toolWithEnv(Map.of("REGION", Map.of("type", "string", "default", "eu")));
    assertThat(ToolContext.forTest(tool, Map.of("REGION", "us"), null).env()).isEqualTo(Map.of("REGION", "us"));
  }

  @Test
  void dropsANameTheToolDoesNotDeclare() {
    Tool<?, ?> tool = toolWithEnv(Map.of("REGION", Map.of("type", "string", "default", "eu")));
    Map<String, String> given = new LinkedHashMap<>();
    given.put("REGION", "us");
    given.put("UNDECLARED", "x");
    assertThat(ToolContext.forTest(tool, given, null).env()).isEqualTo(Map.of("REGION", "us"));
  }

  @Test
  void anEnvlessToolGetsNoEnv() {
    Tool<?, ?> tool = Tool.define("acme.plain").handler((input, ctx) -> input);
    assertThat(ToolContext.forTest(tool, Map.of("X", "1"), null).env()).isEmpty();
  }

  @Test
  void failsNamingAMissingValue() {
    Tool<?, ?> tool = toolWithEnv(Map.of("ACCOUNT_ID", Map.of("type", "string")));
    assertThatThrownBy(() -> ToolContext.forTest(tool, Map.of(), null))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessage("tool \"acme.env\" needs env value \"ACCOUNT_ID\": the context's `env` doesn't set it, "
            + "and its schema has no default");
  }

  @Test
  void failsNamingSeveralMissingValues() {
    Map<String, Object> env = new LinkedHashMap<>();
    env.put("A", Map.of("type", "string"));
    env.put("B", Map.of("type", "string"));
    Tool<?, ?> tool = toolWithEnv(env);
    assertThatThrownBy(() -> ToolContext.forTest(tool, Map.of(), null))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessage("tool \"acme.env\" needs env values \"A\", \"B\": the context's `env` doesn't set them, "
            + "and their schemas have no default");
  }

  @Test
  void failsWhenAValueDoesNotMatchItsSchema() {
    Tool<?, ?> tool = toolWithEnv(Map.of("BASE_URL", Map.of("type", "string", "pattern", "^https://")));
    assertThatThrownBy(() -> ToolContext.forTest(tool, Map.of("BASE_URL", "http://orders.example.com"), null))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessage("env value \"BASE_URL\" is \"http://orders.example.com\", which doesn't match the schema "
            + "tool \"acme.env\" declares for it: must match pattern \"^https://\"");
  }

  @Test
  void checksMissingBeforeInvalid() {
    Map<String, Object> env = new LinkedHashMap<>();
    env.put("A", Map.of("type", "string"));
    env.put("B", Map.of("type", "string", "pattern", "^x"));
    Tool<?, ?> tool = toolWithEnv(env);
    assertThatThrownBy(() -> ToolContext.forTest(tool, Map.of("B", "y"), null))
        .hasMessageContaining("needs env value \"A\"");
  }

  @Test
  void failsWhenADeclaredSchemaDoesNotCompile() {
    Tool<?, ?> tool = toolWithEnv(Map.of("REGION", Map.of("type", "strng")));
    assertThatThrownBy(() -> ToolContext.forTest(tool, Map.of("REGION", "eu"), null))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("declares env value \"REGION\" with a schema that doesn't compile:");
  }

  @Test
  void passesSecretsThrough() {
    Tool<?, ?> tool = toolWithEnv(Map.of("REGION", Map.of("type", "string", "default", "eu")));
    assertThat(ToolContext.forTest(tool, Map.of(), Map.of("API_TOKEN", "t")).secrets())
        .containsEntry("API_TOKEN", "t");
  }

  // --- Test-context builder (ToolContext.forTest(Builder)) ----------------------------------

  @Test
  void theBuilderDefaultsToATestTenantAndRun() {
    ToolContext ctx = ToolContext.forTest(new ToolContext.Builder());
    assertThat(ctx.tenantId()).isEqualTo("t-test");
    assertThat(ctx.runId()).isEqualTo("run-test");
    assertThat(ctx.env()).isEmpty();
    assertThat(ctx.secrets()).isEmpty();
  }

  @Test
  void theBuilderWithAToolDecidesItsEnvAndKeepsTheRest() {
    Tool<?, ?> tool = toolWithEnv(Map.of("REGION", Map.of("type", "string", "default", "eu")));
    Logger log = Logger.noop();
    ToolContext ctx = ToolContext.forTest(new ToolContext.Builder()
        .withTool(tool)
        .withProjectId("p-orders")
        .withConfig(Map.of("pageSize", 50))
        .withLog(log)
        .withEnv(Map.of("UNDECLARED", "x"))
        .withSecrets(Map.of("API_TOKEN", "t")));
    assertThat(ctx.env()).isEqualTo(Map.of("REGION", "eu"));
    assertThat(ctx.projectId()).isEqualTo("p-orders");
    assertThat(ctx.config()).isEqualTo(Map.of("pageSize", 50));
    assertThat(ctx.log()).isSameAs(log);
    assertThat(ctx.secrets()).containsEntry("API_TOKEN", "t");
  }

  @Test
  void theBuilderWithAToolFailsAsForTestDoes() {
    Tool<?, ?> tool = toolWithEnv(Map.of("ACCOUNT_ID", Map.of("type", "string")));
    assertThatThrownBy(() -> ToolContext.forTest(new ToolContext.Builder().withTool(tool).withProjectId("p-orders")))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessage("tool \"acme.env\" needs env value \"ACCOUNT_ID\": the context's `env` doesn't set it, "
            + "and its schema has no default");
  }

  @Test
  void theBuilderOverridesWhatATestSets() {
    ToolContext ctx = ToolContext.forTest(new ToolContext.Builder()
        .withTenantId("acme")
        .withEnv(Map.of("X", "1"))
        .withSecrets(Map.of("KEY", "k")));
    assertThat(ctx.tenantId()).isEqualTo("acme");
    assertThat(ctx.env()).isEqualTo(Map.of("X", "1"));
    assertThat(ctx.secrets()).containsEntry("KEY", "k");
  }
}
