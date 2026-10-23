// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import static org.assertj.core.api.Assertions.assertThat;

import com.kindgi.log.Logger;
import com.kindgi.pack.internal.Json;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** A tool's connections, as in the TypeScript and Python services: readable, never printed. */
class ConnectionsTest {
  private static final String TOKEN = "ya29.acme-token";
  private final ToolConnection mail = new ToolConnection("c-1", "google", "Google", TOKEN,
      new ConnectionAccount("g-1", "ana@acme.example"), null);

  @Test
  void aConnectionsTokenIsReadableButNeverPrinted() {
    ToolContext ctx = ToolContext.forTest(Map.of("mail", mail));
    assertThat(ctx.connections().get("mail").accessToken()).isEqualTo(TOKEN);
    assertThat(ctx.toString()).contains("connections=[mail]").doesNotContain(TOKEN);
    assertThat(mail.toString()).contains("ana@acme.example").doesNotContain(TOKEN);
    assertThat(Json.compactString(Json.plain(ctx))).doesNotContain("connections").doesNotContain(TOKEN);
    assertThat(Json.compactString(Json.plain(mail))).contains("\"connectionId\":\"c-1\"").doesNotContain(TOKEN);
  }

  @Test
  void aContextBuiltTheOldWayHasNone() {
    assertThat(ToolContext.forTest().connections()).isEmpty();
    assertThat(new ToolContext("t1", "r1", null, null, null, Map.of(), Map.of(), Map.of(), Map.of(),
        new Cancellation(), Logger.noop(), "key-1").connections()).isEmpty();
  }

  @Test
  void aConnectionSentMalformedIsLeftOut() {
    ToolContext ctx = Requests.context(Map.of("tenantId", "t1", "runId", "r1", "connections", Map.of(
        "mail", Map.of("connectionId", "c-1", "app", "google", "appName", "Google", "accessToken", TOKEN,
            "account", Map.of("id", "g-1", "label", "ana@acme.example")),
        "noToken", Map.of("connectionId", "c-2", "app", "google", "appName", "Google",
            "account", Map.of("id", "g-2", "label", "bo@acme.example")),
        "noAccount", Map.of("connectionId", "c-3", "app", "google", "appName", "Google", "accessToken", TOKEN))),
        new Cancellation(), Logger.noop());
    assertThat(ctx.connections()).containsOnlyKeys("mail");
    assertThat(ctx.connections().get("mail")).isEqualTo(mail);
    assertThat(Requests.context(Map.of("tenantId", "t1", "runId", "r1"), new Cancellation(), Logger.noop())
        .connections()).isEmpty();
  }

  @Test
  void aRefusalCountsAsItIsOrUpToThreeCausesDeep() {
    ConnectionRejectedException refused = new ConnectionRejectedException("mail");
    assertThat(refused.getMessage()).isEqualTo("the app refused the connection \"mail\"");
    assertThat(refused.connection()).isEqualTo("mail");
    assertThat(PackService.rejectionOf(refused)).isSameAs(refused);
    Throwable wrapped = refused;
    for (int depth = 1; depth <= 3; depth++) {
      wrapped = new IllegalStateException("wrapped " + depth, wrapped);
      assertThat(PackService.rejectionOf(wrapped)).isSameAs(refused);
    }
    assertThat(PackService.rejectionOf(new IllegalStateException("wrapped 4", wrapped))).isNull();
    assertThat(PackService.rejectionOf(new IllegalStateException("boom"))).isNull();
  }
}
