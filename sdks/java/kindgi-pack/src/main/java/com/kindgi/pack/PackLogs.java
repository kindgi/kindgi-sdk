// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import com.kindgi.log.LogFormat;
import com.kindgi.log.LogLevel;
import com.kindgi.log.LogOptions;
import com.kindgi.log.Logger;
import com.kindgi.log.LoggerFromEnv;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * The pack service's log: {@link Logger} records on stderr, subsystem {@code pack} (the runtime
 * writes the same schema). Two streams share the sink:
 *
 * <ul>
 *   <li><b>{@link #log()}</b>: calls, and {@code ctx.log()} beneath them ({@code pack.tool}). {@code
 *       KINDGI_LOG_LEVEL} / {@code KINDGI_LOG_LEVELS} apply.
 *   <li><b>{@link #event}</b>: the lifecycle ({@code listening}, {@code boot-failed}, …), written
 *       whatever the levels, because a supervisor reads it to know the service is up. Its records
 *       carry the event's name as {@code event}, and as {@code kind} too, so a supervisor from before
 *       records (which reads bare {@code {"kind": …}} lines) still sees {@code listening}. {@code
 *       kind} stays through 0.1.x.
 * </ul>
 *
 * The format is {@code KINDGI_LOG_FORMAT}'s, but {@code auto} is pretty only on a terminal: a
 * supervisor pipes stderr, and dev mode ({@code KINDGI_DEV}) doesn't make it pretty, so a supervisor
 * always gets JSON unless told otherwise. The TypeScript and Python pack services log the same way.
 */
final class PackLogs {
  /** Lifecycle events: always written, the supervisor's to read. */
  enum Event {
    LISTENING("listening", LogLevel.INFO),
    BOOT_FAILED("boot-failed", LogLevel.ERROR),
    CONFIG_INVALID("config-invalid", LogLevel.ERROR),
    DRAINING("draining", LogLevel.INFO),
    STOPPED("stopped", LogLevel.INFO);

    final String kind;
    final LogLevel level;

    Event(String kind, LogLevel level) {
      this.kind = kind;
      this.level = level;
    }
  }

  private static final Object STDERR_LOCK = new Object();

  private final Logger log;
  private final Logger always;

  private PackLogs(Logger log, Logger always) {
    this.log = log;
    this.always = always;
  }

  /** The pack service's logs from {@code KINDGI_LOG_*}, or a bad setting's error naming it. */
  sealed interface Outcome permits Ok, Err {}

  /**
   * @param logs the logs
   * @param problems settings that are wrong but harmless, to log at boot
   */
  record Ok(PackLogs logs, List<String> problems) implements Outcome {}

  /** @param message what's wrong, naming the setting */
  record Err(String message) implements Outcome {}

  /**
   * @param env the environment
   * @param write where each line goes (one line, no newline)
   * @param isTTY whether the lines go to a terminal
   * @return the logs, or the error
   */
  static Outcome fromEnv(Map<String, String> env, Consumer<String> write, boolean isTTY) {
    // Dev mode doesn't make the service's records pretty: its supervisor reads them.
    Map<String, String> settings = new HashMap<>(env);
    settings.remove("KINDGI_DEV");
    LoggerFromEnv built = Logger.builder().write(write).subsystem("pack").fromEnv(settings, isTTY, List.of("pack"));
    if (built instanceof LoggerFromEnv.Err) {
      return new Err(((LoggerFromEnv.Err) built).message());
    }
    LoggerFromEnv.Ok ok = (LoggerFromEnv.Ok) built;
    LogFormat resolved = LogFormat.resolve(settings.get("KINDGI_LOG_FORMAT"), isTTY, false);
    LogFormat format = resolved == null ? LogFormat.JSON : resolved;
    Logger always = Logger.builder()
        .level(LogLevel.TRACE)
        .format(format)
        .color(format == LogFormat.PRETTY && isTTY && settings.getOrDefault("NO_COLOR", "").isEmpty())
        .write(write)
        .subsystem("pack")
        .build();
    return new Ok(new PackLogs(ok.logger().child(Map.of("subsystem", "pack")), always), ok.problems());
  }

  /** @return logs for a caller that sets none: records on stderr, at the defaults */
  static PackLogs defaults() {
    return ((Ok) fromEnv(Map.of(), PackLogs::stderr, false)).logs();
  }

  /** One line on stderr. */
  static void stderr(String line) {
    synchronized (STDERR_LOCK) {
      System.err.println(line);
      System.err.flush();
    }
  }

  /** @return calls, and {@code ctx.log()} beneath them; the levels apply */
  Logger log() {
    return log;
  }

  /**
   * A lifecycle event, written whatever the levels.
   *
   * @param event the event
   * @param message what happened, in words
   * @param fields its fields
   */
  void event(Event event, String message, Map<String, ?> fields) {
    Map<String, Object> all = new LinkedHashMap<>(fields);
    all.put("event", event.kind);
    all.put("kind", event.kind);
    always.log(event.level, message, all, LogOptions.NONE);
  }

  /**
   * @param event the event
   * @param message what happened, in words
   */
  void event(Event event, String message) {
    event(event, message, Map.of());
  }

  /** @return logs whose {@link #log()} carries more bindings (the pack's id and artifact version) */
  PackLogs child(Map<String, ?> bindings) {
    return new PackLogs(log.child(bindings), always);
  }
}
