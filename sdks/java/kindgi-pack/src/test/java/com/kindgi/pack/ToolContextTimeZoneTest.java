// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import static org.assertj.core.api.Assertions.assertThat;

import com.kindgi.log.Logger;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** A call's context names the workspace's time zone, as the runtime sends it (pack protocol 2.12.0). */
class ToolContextTimeZoneTest {
  @Test
  void theContextReadsTheTimeZoneFromTheWire() {
    ToolContext ctx = Requests.context(
        Map.of("tenantId", "t-1", "runId", "r-1", "timeZone", "America/Toronto"),
        new Cancellation(), Logger.noop());
    assertThat(ctx.timeZone()).isEqualTo("America/Toronto");
  }

  @Test
  void anOlderRuntimeOrACallOutsideATurnGivesNull() {
    assertThat(Requests.context(Map.of("tenantId", "t-1", "runId", "r-1"), new Cancellation(),
        Logger.noop()).timeZone()).isNull();
    assertThat(Requests.context(Map.of("tenantId", "t-1", "runId", "r-1", "timeZone", 5),
        new Cancellation(), Logger.noop()).timeZone()).isNull();
  }

  @Test
  void aContextBuiltWithTheOlderComponentsHasNone() {
    ToolContext ctx = new ToolContext("t1", "r1", null, null, null, Map.of(), Map.of(), Map.of(),
        Map.of(), new Cancellation(), Logger.noop(), null, Map.of());
    assertThat(ctx.timeZone()).isNull();
  }

  @Test
  void aUnitTestPassesItsOwn() {
    assertThat(ToolContext.forTest(new ToolContext.Builder().withTimeZone("Asia/Tokyo")).timeZone())
        .isEqualTo("Asia/Tokyo");
  }
}
