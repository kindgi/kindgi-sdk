// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.log;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * A logger that writes records: the fixed five ({@code time}, {@code level}, {@code severity},
 * {@code subsystem}, {@code message}), then the correlation ids that are known, in a fixed order,
 * then the event's own fields, then {@code err}, then {@code inMessage} (the fields the message
 * states, of those the record has). A field named like one of the fixed five, or {@code inMessage},
 * can't replace it: it's kept under {@code fields}. The same records as {@code @kindgi/log}.
 */
final class RecordLogger implements Logger {
  /** Correlation fields, in the order a record carries them, after the fixed five. */
  private static final List<String> CORRELATION = List.of(
      "traceId", "spanId", "runTraceId", "requestId", "tenantId", "projectId", "orgId", "runId",
      "parentRunId", "agentId", "agentVersion", "flowId", "flowVersion", "toolId", "conversationId",
      "approvalId");

  private static final List<String> FIXED = List.of("time", "level", "severity", "subsystem", "message");
  /** Names a field can't take: the fixed five and {@code inMessage}, the record's own. */
  private static final Set<String> RESERVED = Set.of("time", "level", "severity", "subsystem", "message", "inMessage");
  private static final Set<String> PRETTY_FIXED =
      Set.of("time", "level", "severity", "subsystem", "message", "err", "inMessage");

  private static final DateTimeFormatter ISO =
      DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final Pattern NEEDS_QUOTES = Pattern.compile("[\\s\"=]");
  private static final Pattern FRAME = Pattern.compile("^\\s*at .*");

  private static final Map<LogLevel, String> LABEL = Map.of(
      LogLevel.ERROR, "ERROR", LogLevel.WARN, "WARN ", LogLevel.INFO, "INFO ", LogLevel.DEBUG, "DEBUG",
      LogLevel.TRACE, "TRACE");
  private static final Map<LogLevel, String> COLOR = Map.of(
      LogLevel.ERROR, "\u001b[31m", LogLevel.WARN, "\u001b[33m", LogLevel.INFO, "\u001b[36m",
      LogLevel.DEBUG, "\u001b[90m", LogLevel.TRACE, "\u001b[90m");
  private static final String RESET = "\u001b[0m";
  private static final String DIM = "\u001b[2m";

  /** What every logger of one tree shares. */
  record Shared(
      LogLevel threshold,
      Map<String, LogLevel> levels,
      LogFormat format,
      boolean color,
      Consumer<String> write,
      List<String> redact,
      String subsystem,
      Clock clock) {}

  private final Shared shared;
  private final Map<String, Object> bindings;
  private final String subsystem;
  private final LogLevel threshold;

  RecordLogger(Shared shared) {
    this(shared, Map.of());
  }

  private RecordLogger(Shared shared, Map<String, Object> bindings) {
    this.shared = shared;
    this.bindings = bindings;
    Object own = bindings.get("subsystem");
    this.subsystem = own instanceof String && !((String) own).isEmpty() ? (String) own : shared.subsystem();
    this.threshold = LogLevel.levelFor(subsystem, shared.levels(), shared.threshold());
  }

  static String isoTime(Instant instant) {
    return ISO.format(instant);
  }

  @Override
  public Logger child(Map<String, ?> more) {
    Map<String, Object> merged = new LinkedHashMap<>(bindings);
    putAll(merged, more);
    return new RecordLogger(shared, Collections.unmodifiableMap(merged));
  }

  @Override
  public boolean isLevelEnabled(LogLevel level) {
    return level.enabledAt(threshold);
  }

  @Override
  public void log(LogLevel level, String message, Map<String, ?> fields, LogOptions options) {
    if (!level.enabledAt(threshold)) {
      return;
    }
    try {
      Map<String, Object> record = record(level, message, fields, options);
      String line = shared.format() == LogFormat.PRETTY
          ? pretty(record, shared.color(), List.of())
          : JSON.writeValueAsString(record);
      shared.write().accept(line);
    } catch (JsonProcessingException | RuntimeException | StackOverflowError e) {
      // Logging must never fail the code that logged, nor a sink that fails.
    }
  }

  private static void putAll(Map<String, Object> into, Map<String, ?> from) {
    for (Map.Entry<String, ?> e : from.entrySet()) {
      if (e.getKey() != null) {
        into.put(e.getKey(), e.getValue());
      }
    }
  }

  @SuppressWarnings("unchecked")
  private Map<String, Object> record(LogLevel level, String message, Map<String, ?> fields, LogOptions options) {
    Map<String, Object> merged = new LinkedHashMap<>(bindings);
    putAll(merged, fields);
    List<String> extra = shared.redact();
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("time", isoTime(shared.clock().instant()));
    out.put("level", level.wireName());
    out.put("severity", level.severity());
    out.put("subsystem", subsystem);
    out.put("message", Redaction.scrubText(message == null ? "null" : message));
    for (String key : CORRELATION) {
      if (merged.containsKey(key)) {
        out.put(key, Redaction.redactValue(merged.get(key), extra));
      }
    }
    Map<String, Object> reserved = new LinkedHashMap<>();
    for (Map.Entry<String, Object> e : merged.entrySet()) {
      String key = e.getKey();
      if (key.equals("subsystem") || key.equals("err") || CORRELATION.contains(key)) {
        continue;
      }
      if (RESERVED.contains(key)) {
        reserved.put(key, e.getValue());
      } else {
        out.put(key, e.getValue() instanceof Throwable
            ? Errors.serialize(e.getValue(), level == LogLevel.ERROR)
            : e.getValue());
      }
    }
    Map<String, Object> redacted = (Map<String, Object>) Redaction.redactValue(out, extra);
    // The fixed five are the record's own, never redacted as fields.
    for (String key : FIXED) {
      redacted.put(key, out.get(key));
    }
    if (!reserved.isEmpty()) {
      redacted.put("fields", Redaction.redactValue(reserved, extra));
    }
    if (merged.get("err") != null) {
      boolean withStack = level == LogLevel.ERROR || LogLevel.DEBUG.enabledAt(threshold);
      redacted.put("err", Errors.serialize(merged.get("err"), withStack));
    }
    // The fields the message states, of those the record has: a renderer (the pretty format,
    // `kindgi dev`) leaves them out of the line.
    List<String> stated = new ArrayList<>();
    for (String key : options.inMessage()) {
      if (!RESERVED.contains(key) && !key.equals("err") && redacted.containsKey(key) && !stated.contains(key)) {
        stated.add(key);
      }
    }
    if (!stated.isEmpty()) {
      redacted.put("inMessage", stated);
    }
    return redacted;
  }

  // ---------------------------------------------------------------------------------------------
  // The pretty format: HH:MM:SS.mmm LEVEL [subsystem] message key=value …
  // ---------------------------------------------------------------------------------------------

  private static String prettyValue(Object value) {
    try {
      if (value instanceof String) {
        String s = (String) value;
        return s.isEmpty() || NEEDS_QUOTES.matcher(s).find() ? JSON.writeValueAsString(s) : s;
      }
      return JSON.writeValueAsString(value);
    } catch (JsonProcessingException e) {
      return String.valueOf(value);
    }
  }

  @SuppressWarnings("unchecked")
  private static List<String> errorLines(Map<String, Object> err) {
    List<String> lines = new ArrayList<>();
    Object code = err.get("code");
    lines.add(err.get("name") + ": " + err.get("message") + (code != null ? " (" + code + ")" : ""));
    if (err.get("stack") instanceof String) {
      for (String line : ((String) err.get("stack")).split("\n", -1)) {
        if (FRAME.matcher(line).matches()) {
          lines.add("    " + line.strip());
        }
      }
    }
    Object cause = err.get("cause");
    if (cause instanceof Map) {
      lines.add("  caused by: " + String.join("\n  ", errorLines((Map<String, Object>) cause)));
    } else if (cause != null) {
      lines.add("  caused by: " + cause);
    }
    return lines;
  }

  /**
   * The pretty format, for a person at a terminal. Colours only when {@code color} is set. The fields
   * the message already states (the record's {@code inMessage}, and any in {@code omit}) are left
   * out of the line, so a record read back from JSON renders as it would have at the source.
   */
  @SuppressWarnings("unchecked")
  static String pretty(Map<String, Object> record, boolean color, List<String> omit) {
    List<String> stated = new ArrayList<>(omit);
    if (record.get("inMessage") instanceof List) {
      for (Object key : (List<Object>) record.get("inMessage")) {
        stated.add(String.valueOf(key));
      }
    }
    LogLevel level = LogLevel.parse(String.valueOf(record.get("level")));
    String time = String.valueOf(record.get("time")).substring(11, 23);
    String label = LABEL.get(level);
    List<String> head = new ArrayList<>();
    head.add(color ? DIM + time + RESET : time);
    head.add(color ? COLOR.get(level) + label + RESET : label);
    head.add("[" + record.get("subsystem") + "]");
    head.add(String.valueOf(record.get("message")));
    for (Map.Entry<String, Object> e : record.entrySet()) {
      if (!PRETTY_FIXED.contains(e.getKey()) && !stated.contains(e.getKey())) {
        head.add(e.getKey() + "=" + prettyValue(e.getValue()));
      }
    }
    String line = String.join(" ", head);
    Object err = record.get("err");
    if (err == null) {
      return line;
    }
    if (!(err instanceof Map)) {
      return line + " err=" + prettyValue(err);
    }
    List<String> lines = errorLines((Map<String, Object>) err);
    lines.set(0, line + " err=" + prettyValue(lines.get(0)));
    return String.join("\n", lines);
  }
}
