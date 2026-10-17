// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.log;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/** W3C Trace Context, as {@code @kindgi/log} reads and writes it. */
class TraceContextTest {
  private static final String TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
  private static final String SPAN = "00f067aa0ba902b7";

  @Test
  void aValidHeaderIsTheCallersSpan() {
    assertThat(TraceContext.parse(" 00-" + TRACE + "-" + SPAN + "-01 "))
        .isEqualTo(new TraceContext(TRACE, SPAN, null, "01"));
    // A future version is read by its first four fields.
    assertThat(TraceContext.parse("01-" + TRACE + "-" + SPAN + "-00-extra")).isNotNull();
  }

  @Test
  void aBadHeaderIsNeverTrusted() {
    assertThat(TraceContext.parse(null)).isNull();
    assertThat(TraceContext.parse("00-" + TRACE.toUpperCase() + "-" + SPAN + "-01")).isNull();
    assertThat(TraceContext.parse("ff-" + TRACE + "-" + SPAN + "-01")).isNull();
    assertThat(TraceContext.parse("00-" + TRACE + "-" + SPAN + "-01-extra")).isNull();
    assertThat(TraceContext.parse("00-" + "0".repeat(32) + "-" + SPAN + "-01")).isNull();
    assertThat(TraceContext.parse("00-" + TRACE + "-" + "0".repeat(16) + "-01")).isNull();
    assertThat(TraceContext.parse("00-" + TRACE + "-" + SPAN)).isNull();
  }

  @Test
  void aChildSpanKeepsTheTraceAndNamesItsParent() {
    TraceContext caller = TraceContext.parse("00-" + TRACE + "-" + SPAN + "-01");
    TraceContext mine = caller.child();
    assertThat(mine.traceId()).isEqualTo(TRACE);
    assertThat(mine.parentSpanId()).isEqualTo(SPAN);
    assertThat(mine.spanId()).matches("[0-9a-f]{16}").isNotEqualTo(SPAN);
    assertThat(mine.traceparent()).isEqualTo("00-" + TRACE + "-" + mine.spanId() + "-01");
  }

  @Test
  void withoutAValidHeaderARequestStartsAFreshSampledTrace() {
    TraceContext fresh = TraceContext.fromHeader("garbage");
    assertThat(fresh.traceId()).matches("[0-9a-f]{32}");
    assertThat(fresh.parentSpanId()).isNull();
    assertThat(fresh.flags()).isEqualTo("01");
    assertThat(TraceContext.fromHeader("00-" + TRACE + "-" + SPAN + "-01").parentSpanId()).isEqualTo(SPAN);
  }
}
