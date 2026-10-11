// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.log;

import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.function.Consumer;
import org.jspecify.annotations.Nullable;

/**
 * Builds a {@link Logger}: by hand ({@link #build()}), or from the {@code KINDGI_LOG_*} settings
 * ({@link #fromEnv}).
 */
public final class LoggerBuilder {
  private LogLevel level = LogLevel.INFO;
  private Map<String, LogLevel> levels = Map.of();
  private LogFormat format = LogFormat.JSON;
  private boolean color;
  private Consumer<String> write = System.out::println;
  private List<String> redact = List.of();
  private String subsystem = "root";
  private Clock clock = Clock.systemUTC();

  LoggerBuilder() {}

  /**
   * @param level records below it aren't written ({@code KINDGI_LOG_LEVEL}); default {@code info}
   * @return this builder
   */
  public LoggerBuilder level(LogLevel level) {
    this.level = Objects.requireNonNull(level, "level");
    return this;
  }

  /**
   * @param levels per-subsystem levels; a dotted name inherits its parent's ({@code
   *     KINDGI_LOG_LEVELS})
   * @return this builder
   */
  public LoggerBuilder levels(Map<String, LogLevel> levels) {
    this.levels = Map.copyOf(levels);
    return this;
  }

  /**
   * @param format JSON (one record per line, the default) or pretty (for a terminal)
   * @return this builder
   */
  public LoggerBuilder format(LogFormat format) {
    this.format = Objects.requireNonNull(format, "format");
    return this;
  }

  /**
   * @param color colours in the pretty format (a terminal, {@code NO_COLOR} unset); default off
   * @return this builder
   */
  public LoggerBuilder color(boolean color) {
    this.color = color;
    return this;
  }

  /**
   * @param write where each line goes: one complete line, no trailing newline; default stdout
   * @return this builder
   */
  public LoggerBuilder write(Consumer<String> write) {
    this.write = Objects.requireNonNull(write, "write");
    return this;
  }

  /**
   * @param keys more field keys to redact, on top of the built-in ones ({@link Redaction})
   * @return this builder
   */
  public LoggerBuilder redact(List<String> keys) {
    this.redact = List.copyOf(keys);
    return this;
  }

  /**
   * @param subsystem the records' subsystem until a child names one; default {@code root}
   * @return this builder
   */
  public LoggerBuilder subsystem(String subsystem) {
    this.subsystem = Objects.requireNonNull(subsystem, "subsystem");
    return this;
  }

  /**
   * @param clock the records' clock (tests)
   * @return this builder
   */
  public LoggerBuilder clock(Clock clock) {
    this.clock = Objects.requireNonNull(clock, "clock");
    return this;
  }

  /** @return the logger */
  public Logger build() {
    return new RecordLogger(new RecordLogger.Shared(level, levels, format, color, write, redact, subsystem, clock));
  }

  /**
   * The root logger from {@code KINDGI_LOG_LEVEL}, {@code KINDGI_LOG_LEVELS} and {@code
   * KINDGI_LOG_FORMAT}, writing to this builder's sink with its redaction keys, subsystem and clock
   * (the settings decide the level, the levels, the format and the colours). An unknown level or
   * format, or a malformed {@code KINDGI_LOG_LEVELS}, is an error; a subsystem not in {@code
   * subsystems} (when given) is a problem to report, not a refusal, so a typo doesn't stop a server.
   * {@code auto} is pretty on a terminal or under {@code KINDGI_DEV}.
   *
   * @param env the environment
   * @param isTTY whether the lines go to a terminal
   * @param subsystems the subsystems the caller logs under, to flag an unknown one; {@code null} not
   *     to check
   * @return the logger, or the error that names a bad setting
   */
  public LoggerFromEnv fromEnv(Map<String, String> env, boolean isTTY, @Nullable List<String> subsystems) {
    String rawLevel = env.get("KINDGI_LOG_LEVEL");
    LogLevel parsedLevel = rawLevel == null || rawLevel.isBlank() ? LogLevel.INFO : LogLevel.parse(rawLevel);
    if (parsedLevel == null) {
      return new LoggerFromEnv.Err(
          "KINDGI_LOG_LEVEL must be one of " + LogLevel.names() + ", got \"" + rawLevel + "\".");
    }
    Map<String, LogLevel> parsedLevels;
    try {
      parsedLevels = LogLevel.parseLevels(env.getOrDefault("KINDGI_LOG_LEVELS", ""));
    } catch (IllegalArgumentException e) {
      return new LoggerFromEnv.Err("KINDGI_LOG_LEVELS: " + e.getMessage() + ".");
    }
    String dev = env.getOrDefault("KINDGI_DEV", "").strip().toLowerCase(Locale.ROOT);
    LogFormat parsedFormat =
        LogFormat.resolve(env.get("KINDGI_LOG_FORMAT"), isTTY, dev.equals("true") || dev.equals("1"));
    if (parsedFormat == null) {
      return new LoggerFromEnv.Err(
          "KINDGI_LOG_FORMAT must be auto, json or pretty, got \"" + env.get("KINDGI_LOG_FORMAT") + "\".");
    }
    List<String> problems = new ArrayList<>();
    if (subsystems != null) {
      for (String name : parsedLevels.keySet()) {
        String root = name.contains(".") ? name.substring(0, name.indexOf('.')) : name;
        if (!subsystems.contains(name) && !subsystems.contains(root)) {
          problems.add("KINDGI_LOG_LEVELS names \"" + name + "\", which no subsystem logs under; it has no effect.");
        }
      }
    }
    boolean colored = parsedFormat == LogFormat.PRETTY && isTTY && env.getOrDefault("NO_COLOR", "").isEmpty();
    Logger logger = new LoggerBuilder()
        .level(parsedLevel)
        .levels(parsedLevels)
        .format(parsedFormat)
        .color(colored)
        .write(write)
        .redact(redact)
        .subsystem(subsystem)
        .clock(clock)
        .build();
    return new LoggerFromEnv.Ok(logger, problems);
  }
}
