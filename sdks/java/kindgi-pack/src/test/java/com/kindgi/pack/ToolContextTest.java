// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import static org.assertj.core.api.Assertions.assertThat;

import com.kindgi.log.Logger;
import com.kindgi.pack.internal.Json;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** A context never prints a secret's value, as in the TypeScript and Python services. */
class ToolContextTest {
  private final ToolContext ctx = new ToolContext("t1", "r1", null, null, null, Map.of(),
      Map.of("API_KEY", "s3cret-value"), Map.of(), Map.of(), new Cancellation(), Logger.noop());

  @Test
  void secretsAreReadableButNeverPrinted() {
    assertThat(ctx.secrets().get("API_KEY")).isEqualTo("s3cret-value");
    assertThat(ctx.secrets()).containsEntry("API_KEY", "s3cret-value").hasSize(1);
    assertThat(ctx.toString()).contains("API_KEY").doesNotContain("s3cret-value");
    assertThat(ctx.secrets().toString()).isEqualTo("{API_KEY=<hidden>}");
    assertThat(String.valueOf(ctx.secrets())).doesNotContain("s3cret-value");
  }

  @Test
  void theContextsJsonLeavesThemOut() {
    String json = Json.compactString(Json.plain(ctx));
    assertThat(json).contains("\"tenantId\":\"t1\"").doesNotContain("secrets").doesNotContain("s3cret-value")
        .doesNotContain("\"log\"");
  }

  @Test
  void aTestContextsLoggerWritesNothing() {
    assertThat(ToolContext.forTest().log()).isSameAs(Logger.noop());
    assertThat(ToolContext.forTest().log().isLevelEnabled(com.kindgi.log.LogLevel.ERROR)).isFalse();
    java.util.List<String> lines = new java.util.ArrayList<>();
    ToolContext.forTest(Logger.builder().write(lines::add).build()).log().info("looked up order", Map.of("orderId", "o-1"));
    assertThat(lines).singleElement().asString().contains("\"orderId\":\"o-1\"");
  }
}
