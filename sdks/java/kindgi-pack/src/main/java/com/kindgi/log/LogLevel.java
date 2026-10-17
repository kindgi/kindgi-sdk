// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.log;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * Log levels, most severe first. A level says how much attention a line needs: {@code error} (an
 * operator should look), {@code warn} (unexpected but handled), {@code info} (what happened, at the
 * operator's grain), {@code debug} (the decisions behind it), {@code trace} (internals, briefly).
 */
public enum LogLevel {
  /** An operator should look. */
  ERROR(50, "ERROR"),
  /** Unexpected but handled. */
  WARN(40, "WARNING"),
  /** What happened, at the operator's grain. */
  INFO(30, "INFO"),
  /** The decisions behind it. */
  DEBUG(20, "DEBUG"),
  /** Internals, briefly. */
  TRACE(10, "DEBUG");

  private final int rank;
  private final String severity;

  LogLevel(int rank, String severity) {
    this.rank = rank;
    this.severity = severity;
  }

  /** @return the level's name in a record: {@code error}, {@code warn}, {@code info}, {@code debug} or {@code trace} */
  public String wireName() {
    return name().toLowerCase(Locale.ROOT);
  }

  /**
   * @return Cloud Logging's name for the level ({@code WARNING} for {@code warn}, {@code DEBUG} for
   *     {@code trace}), so Cloud Run and GKE show levels with no agent configuration
   */
  public String severity() {
    return severity;
  }

  /**
   * @param threshold a logger's level
   * @return whether a record at this level is written by a logger at {@code threshold}
   */
  public boolean enabledAt(LogLevel threshold) {
    return rank >= threshold.rank;
  }

  /**
   * @param raw a level's name, case and surrounding spaces aside
   * @return the level, or {@code null} when it isn't one
   */
  public static @Nullable LogLevel parse(@Nullable String raw) {
    if (raw == null) {
      return null;
    }
    String value = raw.strip().toLowerCase(Locale.ROOT);
    for (LogLevel level : values()) {
      if (level.wireName().equals(value)) {
        return level;
      }
    }
    return null;
  }

  /** @return the levels' names, most severe first, joined by commas: for messages */
  static String names() {
    StringBuilder out = new StringBuilder();
    for (LogLevel level : values()) {
      out.append(out.length() == 0 ? "" : ", ").append(level.wireName());
    }
    return out.toString();
  }

  /**
   * Per-subsystem levels, {@code KINDGI_LOG_LEVELS}'s form: a comma list of {@code subsystem=level},
   * such as {@code kernel=debug,http=warn}. Empty is none. Whether a subsystem exists is the
   * caller's question.
   *
   * @param raw the list
   * @return the levels by subsystem, in the order given
   * @throws IllegalArgumentException quoting an entry that isn't {@code name=level}, or names no
   *     known level
   */
  public static Map<String, LogLevel> parseLevels(String raw) {
    Map<String, LogLevel> levels = new LinkedHashMap<>();
    for (String entry : raw.split(",", -1)) {
      String trimmed = entry.strip();
      if (trimmed.isEmpty()) {
        continue;
      }
      int eq = trimmed.indexOf('=');
      String subsystem = eq == -1 ? "" : trimmed.substring(0, eq).strip();
      LogLevel level = eq == -1 ? null : parse(trimmed.substring(eq + 1));
      if (subsystem.isEmpty() || level == null) {
        throw new IllegalArgumentException(
            "\"" + trimmed + "\" isn't subsystem=level (levels: " + names() + ")");
      }
      levels.put(subsystem, level);
    }
    return Collections.unmodifiableMap(levels);
  }

  /**
   * The level for a subsystem: its own entry, else its nearest dotted parent's ({@code
   * kernel=debug} covers {@code kernel.sweeper}), else {@code fallback}.
   *
   * @param subsystem the subsystem
   * @param levels the levels by subsystem
   * @param fallback the level when no entry covers it
   * @return the level
   */
  public static LogLevel levelFor(String subsystem, Map<String, LogLevel> levels, LogLevel fallback) {
    String name = subsystem;
    while (true) {
      LogLevel own = levels.get(name);
      if (own != null) {
        return own;
      }
      int dot = name.lastIndexOf('.');
      if (dot == -1) {
        return fallback;
      }
      name = name.substring(0, dot);
    }
  }
}
