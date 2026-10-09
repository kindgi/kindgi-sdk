// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * The run a check evaluates, as the runtime sends it ({@code RunTrace}): its output, its tool calls
 * and results, its model calls. Fields a newer runtime adds are in {@link #raw()}.
 */
public final class RunTrace {
  private final Map<String, Object> raw;

  /** @param raw the trace, as sent */
  public RunTrace(Map<String, Object> raw) {
    this.raw = Collections.unmodifiableMap(new LinkedHashMap<>(raw));
  }

  /** @return the trace, as sent */
  public Map<String, Object> raw() {
    return raw;
  }

  /** @return the run's id */
  public @Nullable String runId() {
    return text("runId");
  }

  /** @return the tenant's id */
  public @Nullable String tenantId() {
    return text("tenantId");
  }

  /** @return the final output text, when the run produced text */
  public @Nullable String output() {
    return text("output");
  }

  /** @return the user's input text, when there was one */
  public @Nullable String userInput() {
    return text("userInput");
  }

  /** @return {@code runtime} or {@code ci} */
  public String mode() {
    String mode = text("mode");
    return mode == null ? "runtime" : mode;
  }

  /** @return the tool calls, as sent */
  public List<Object> toolCalls() {
    return list("toolCalls");
  }

  /** @return the tool results, as sent */
  public List<Object> toolResults() {
    return list("toolResults");
  }

  /** @return the model calls, as sent */
  public List<Object> modelCalls() {
    return list("modelCalls");
  }

  private @Nullable String text(String key) {
    Object v = raw.get(key);
    return v instanceof String ? (String) v : null;
  }

  @SuppressWarnings("unchecked")
  private List<Object> list(String key) {
    Object v = raw.get(key);
    return v instanceof List ? Collections.unmodifiableList((List<Object>) v) : List.of();
  }
}
