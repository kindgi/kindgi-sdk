// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.log;

import java.util.Map;

/**
 * Kindgi's structured logger: the records the runtime and every pack service write, in JSON or a
 * terminal's format, redacted. A record carries a message and fields, values never pasted into the
 * message: {@code log.info("looked up order", Map.of("orderId", orderId))}.
 *
 * <p>{@link #child} returns a logger whose records all carry its bindings ({@code
 * log.child(Map.of("subsystem", "leases"))}, {@code log.child(Map.of("runId", runId))}); a child's
 * {@code subsystem} replaces its parent's, so name it in full ({@code kernel.sweeper}). Pass an error
 * as the {@code err} field, or with {@link #error(String, Throwable)}.
 *
 * <p>Logging never throws, and a sink that fails is ignored.
 */
public interface Logger {
  /**
   * Writes a record, when its level is enabled.
   *
   * @param level the record's level
   * @param message what happened, in words
   * @param fields the event's own fields
   * @param options how the record is written
   */
  void log(LogLevel level, String message, Map<String, ?> fields, LogOptions options);

  /**
   * @param bindings fields every record of the child carries
   * @return the child logger
   */
  Logger child(Map<String, ?> bindings);

  /**
   * @param level a level
   * @return whether a record at {@code level} would be written: skip building costly fields when it
   *     wouldn't
   */
  boolean isLevelEnabled(LogLevel level);

  /** @param message what happened */
  default void error(String message) {
    log(LogLevel.ERROR, message, Map.of(), LogOptions.NONE);
  }

  /**
   * @param message what happened
   * @param fields the event's fields
   */
  default void error(String message, Map<String, ?> fields) {
    log(LogLevel.ERROR, message, fields, LogOptions.NONE);
  }

  /**
   * @param message what happened
   * @param err the error, as the record's {@code err}
   */
  default void error(String message, Throwable err) {
    log(LogLevel.ERROR, message, Map.of("err", err), LogOptions.NONE);
  }

  /** @param message what happened */
  default void warn(String message) {
    log(LogLevel.WARN, message, Map.of(), LogOptions.NONE);
  }

  /**
   * @param message what happened
   * @param fields the event's fields
   */
  default void warn(String message, Map<String, ?> fields) {
    log(LogLevel.WARN, message, fields, LogOptions.NONE);
  }

  /**
   * @param message what happened
   * @param err the error, as the record's {@code err}
   */
  default void warn(String message, Throwable err) {
    log(LogLevel.WARN, message, Map.of("err", err), LogOptions.NONE);
  }

  /** @param message what happened */
  default void info(String message) {
    log(LogLevel.INFO, message, Map.of(), LogOptions.NONE);
  }

  /**
   * @param message what happened
   * @param fields the event's fields
   */
  default void info(String message, Map<String, ?> fields) {
    log(LogLevel.INFO, message, fields, LogOptions.NONE);
  }

  /** @param message what happened */
  default void debug(String message) {
    log(LogLevel.DEBUG, message, Map.of(), LogOptions.NONE);
  }

  /**
   * @param message what happened
   * @param fields the event's fields
   */
  default void debug(String message, Map<String, ?> fields) {
    log(LogLevel.DEBUG, message, fields, LogOptions.NONE);
  }

  /** @param message what happened */
  default void trace(String message) {
    log(LogLevel.TRACE, message, Map.of(), LogOptions.NONE);
  }

  /**
   * @param message what happened
   * @param fields the event's fields
   */
  default void trace(String message, Map<String, ?> fields) {
    log(LogLevel.TRACE, message, fields, LogOptions.NONE);
  }

  /** @return a logger that writes nothing: the default where one isn't given ({@code ToolContext.forTest()}) */
  static Logger noop() {
    return NoopLogger.INSTANCE;
  }

  /** @return a builder for a logger that writes records */
  static LoggerBuilder builder() {
    return new LoggerBuilder();
  }
}
