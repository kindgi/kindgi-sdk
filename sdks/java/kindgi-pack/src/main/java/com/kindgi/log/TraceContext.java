// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.log;

import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * W3C Trace Context ({@code traceparent}): the ids every record written inside a request or a run
 * carries. Honour a caller's trace, or start one, and give each request its own span. No spans are
 * recorded or exported here.
 *
 * @param traceId 32 lowercase hex characters, not all zero
 * @param spanId 16 lowercase hex characters, not all zero: this span
 * @param parentSpanId the span this one is a child of, when there is one
 * @param flags trace flags, two hex characters; {@code 01} is sampled
 */
public record TraceContext(String traceId, String spanId, @Nullable String parentSpanId, String flags) {
  private static final Pattern TRACEPARENT =
      Pattern.compile("^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$");
  private static final Pattern ZEROS = Pattern.compile("^0+$");
  private static final SecureRandom RANDOM = new SecureRandom();

  /**
   * An incoming {@code traceparent}, as the caller's span: its trace id, its span id and its flags.
   * {@code null} when the header is absent or malformed: then the caller starts a fresh trace (a bad
   * header is replaced, never trusted). Hex must be lowercase. Version {@code ff} is invalid; a
   * future version is read by its first four fields, as the spec says. All-zero ids are invalid.
   *
   * @param header the header's value
   * @return the caller's span, or {@code null}
   */
  public static @Nullable TraceContext parse(@Nullable String header) {
    if (header == null) {
      return null;
    }
    String value = header.strip();
    Matcher m = TRACEPARENT.matcher(value);
    if (!m.matches()) {
      return null;
    }
    String version = m.group(1);
    if (version.equals("ff") || (version.equals("00") && value.length() != 55)) {
      return null;
    }
    if (ZEROS.matcher(m.group(2)).matches() || ZEROS.matcher(m.group(3)).matches()) {
      return null;
    }
    return new TraceContext(m.group(2), m.group(3), null, m.group(4));
  }

  /** @return a fresh trace: a new trace id and a first span, sampled */
  public static TraceContext newTrace() {
    return new TraceContext(randomHex(16), randomHex(8), null, "01");
  }

  /**
   * The context for a request: a child span of the caller's trace when its {@code traceparent} is
   * valid, else a fresh trace.
   *
   * @param header the request's {@code traceparent}
   * @return the request's context
   */
  public static TraceContext fromHeader(@Nullable String header) {
    TraceContext caller = parse(header);
    return caller == null ? newTrace() : caller.child();
  }

  /** @return a new span in the same trace, whose parent is this span */
  public TraceContext child() {
    return new TraceContext(traceId, randomHex(8), spanId, flags);
  }

  /** @return the {@code traceparent} (and {@code traceresponse}) value: {@code 00-<trace>-<span>-<flags>} */
  public String traceparent() {
    return "00-" + traceId + "-" + spanId + "-" + flags;
  }

  private static String randomHex(int bytes) {
    byte[] buf = new byte[bytes];
    while (true) {
      RANDOM.nextBytes(buf);
      String hex = HexFormat.of().formatHex(buf);
      if (!ZEROS.matcher(hex).matches()) {
        return hex;
      }
    }
  }
}
