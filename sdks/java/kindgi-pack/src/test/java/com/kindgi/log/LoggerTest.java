// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.log;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** What the shared vectors don't cover: the pretty format, errors' stacks, values Java has, the settings. */
class LoggerTest {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-10-08T12:34:56.789Z"), ZoneOffset.UTC);

  private final List<String> lines = new ArrayList<>();

  private LoggerBuilder builder() {
    return Logger.builder().write(lines::add).clock(CLOCK).subsystem("pack");
  }

  private Map<String, Object> only() throws IOException {
    assertThat(lines).hasSize(1);
    return JSON.readValue(lines.get(0), new TypeReference<LinkedHashMap<String, Object>>() {});
  }

  /** A record carrying a nested value, with a code. */
  record Order(String id, String apiKey, List<String> items) {}

  static final class Declined extends IllegalStateException {
    private static final long serialVersionUID = 1L;

    Declined(String message, Throwable cause) {
      super(message, cause);
    }

    public int getCode() {
      return 402;
    }
  }

  @Test
  void thePrettyFormatIsALineForAPersonAndLeavesOutWhatTheMessageStates() {
    Logger log = builder().format(LogFormat.PRETTY).build().child(Map.of("runId", "r1"));
    Map<String, Object> fields = new LinkedHashMap<>();
    fields.put("outcome", "ok");
    fields.put("durationMs", 12);
    fields.put("note", "two words");
    fields.put("empty", "");
    log.log(LogLevel.INFO, "tool acme.lookup ok 12ms", fields, LogOptions.inMessage("outcome", "durationMs"));
    assertThat(lines).containsExactly(
        "12:34:56.789 INFO  [pack] tool acme.lookup ok 12ms runId=r1 note=\"two words\" empty=\"\"");
  }

  @Test
  void colorsOnlyWhenAsked() {
    builder().format(LogFormat.PRETTY).color(true).build().warn("careful");
    assertThat(lines.get(0)).isEqualTo("\u001b[2m12:34:56.789\u001b[0m \u001b[33mWARN \u001b[0m [pack] careful");
  }

  @Test
  void anErrorAtErrorCarriesItsStackAndCausesAndPrettyShowsTheFrames() throws IOException {
    Logger log = builder().build();
    log.error("charge failed", new Declined("card declined for kgi_bt_0123456789abcdefWXYZ",
        new IllegalArgumentException("bad amount")));
    @SuppressWarnings("unchecked")
    Map<String, Object> err = (Map<String, Object>) only().get("err");
    assertThat(err).containsEntry("name", "Declined").containsEntry("message", "card declined for kgi_bt_…WXYZ")
        .containsEntry("code", "402");
    assertThat((String) err.get("stack")).contains("Declined: card declined for kgi_bt_…WXYZ")
        .contains("\n    at com.kindgi.log.LoggerTest").doesNotContain("0123456789abcdef");
    assertThat(err.get("cause")).asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.MAP)
        .containsEntry("name", "IllegalArgumentException").containsEntry("message", "bad amount").containsKey("stack");
    assertThat(new ArrayList<>(err.keySet())).containsExactly("name", "message", "code", "stack", "cause");

    lines.clear();
    Logger pretty = builder().format(LogFormat.PRETTY).build();
    pretty.error("charge failed", new Declined("card declined", new IllegalArgumentException("bad amount")));
    String[] out = lines.get(0).split("\n");
    assertThat(out[0]).isEqualTo("12:34:56.789 ERROR [pack] charge failed err=\"Declined: card declined (402)\"");
    assertThat(out[1]).startsWith("    at com.kindgi.log.LoggerTest");
    assertThat(lines.get(0)).contains("\n  caused by: IllegalArgumentException: bad amount");
  }

  @Test
  void aWarningsErrorHasNoStackUnlessTheLoggerIsAtDebug() throws IOException {
    builder().build().warn("retrying", new IllegalStateException("busy"));
    assertThat(only().get("err")).asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.MAP)
        .doesNotContainKey("stack");
    lines.clear();
    builder().level(LogLevel.DEBUG).build().warn("retrying", new IllegalStateException("busy"));
    assertThat(only().get("err")).asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.MAP).containsKey("stack");
  }

  @Test
  void recordsBeansAndCollectionsBecomeJsonAndAreRedactedInside() throws IOException {
    Map<String, Object> fields = new LinkedHashMap<>();
    fields.put("order", new Order("o-1", "sk-live", List.of("a", "b")));
    fields.put("ids", new int[] {1, 2});
    fields.put("at", Instant.parse("2026-10-08T12:00:00Z"));
    fields.put("level", LogLevel.WARN);
    fields.put("nan", Double.NaN);
    fields.put("maybe", java.util.Optional.of("x"));
    builder().build().info("order", fields);
    Map<String, Object> got = only();
    assertThat(got).containsEntry("order", Map.of("id", "o-1", "apiKey", "[redacted]", "items", List.of("a", "b")))
        .containsEntry("ids", List.of(1, 2)).containsEntry("at", "2026-10-08T12:00:00.000Z")
        .containsEntry("nan", null).containsEntry("maybe", "x");
    // A field named like one of the fixed five is kept under `fields`, never replacing it.
    assertThat(got).containsEntry("level", "info").containsEntry("fields", Map.of("level", "WARN"));
  }

  @Test
  void aCycleAndTooDeepAValueBecomeMarkers() throws IOException {
    Map<String, Object> self = new HashMap<>();
    self.put("me", self);
    Map<String, Object> deep = new LinkedHashMap<>();
    Map<String, Object> at = deep;
    for (int i = 0; i < 10; i++) {
      Map<String, Object> next = new LinkedHashMap<>();
      at.put("d", next);
      at = next;
    }
    Map<String, Object> fields = new LinkedHashMap<>();
    fields.put("self", self);
    fields.put("deep", deep);
    builder().build().info("shapes", fields);
    String line = lines.get(0);
    assertThat(line).contains("\"self\":{\"me\":\"[circular]\"}").contains("\"[too deep]\"");
  }

  @Test
  void aSinkThatFailsNeverFailsTheCaller() {
    Logger log = Logger.builder().write(line -> {
      throw new IllegalStateException("disk full");
    }).build();
    log.info("still fine");
    log.error("still fine", new RuntimeException("x"));
  }

  @Test
  void aChildsSubsystemReplacesItsParentsAndPicksItsLevel() throws IOException {
    Logger root = builder().level(LogLevel.WARN).levels(Map.of("pack", LogLevel.DEBUG)).build();
    Logger tool = root.child(Map.of("subsystem", "pack.tool", "runId", "r1"));
    assertThat(tool.isLevelEnabled(LogLevel.DEBUG)).isTrue();
    assertThat(root.child(Map.of("subsystem", "kernel")).isLevelEnabled(LogLevel.INFO)).isFalse();
    tool.debug("detail", Map.of("subsystem", "ignored"));
    assertThat(only()).containsEntry("subsystem", "pack.tool").containsEntry("runId", "r1").doesNotContainKey("fields");
  }

  @Test
  void extraRedactionKeys() throws IOException {
    builder().redact(List.of("ssn")).build().info("person", Map.of("ssn", "123", "customer_SSN", "456", "name", "Ada"));
    assertThat(only()).containsEntry("ssn", "[redacted]").containsEntry("customer_SSN", "[redacted]")
        .containsEntry("name", "Ada");
  }

  @Test
  void theNoopLoggerWritesNothing() {
    Logger log = Logger.noop();
    log.error("nothing");
    assertThat(log.child(Map.of("runId", "r1"))).isSameAs(log);
    assertThat(log.isLevelEnabled(LogLevel.ERROR)).isFalse();
  }

  @Test
  void theSettings() {
    LoggerFromEnv ok = builder().fromEnv(
        Map.of("KINDGI_LOG_LEVEL", " DEBUG ", "KINDGI_LOG_LEVELS", "pack.tool=trace,kernel=warn"), false, List.of("pack"));
    assertThat(ok).isInstanceOf(LoggerFromEnv.Ok.class);
    assertThat(((LoggerFromEnv.Ok) ok).problems())
        .containsExactly("KINDGI_LOG_LEVELS names \"kernel\", which no subsystem logs under; it has no effect.");
    Logger log = ((LoggerFromEnv.Ok) ok).logger();
    assertThat(log.isLevelEnabled(LogLevel.DEBUG)).isTrue();
    assertThat(log.child(Map.of("subsystem", "pack.tool")).isLevelEnabled(LogLevel.TRACE)).isTrue();

    assertThat(builder().fromEnv(Map.of("KINDGI_LOG_LEVEL", "loud"), false, null)).isEqualTo(new LoggerFromEnv.Err(
        "KINDGI_LOG_LEVEL must be one of error, warn, info, debug, trace, got \"loud\"."));
    assertThat(builder().fromEnv(Map.of("KINDGI_LOG_LEVELS", "pack"), false, null)).isEqualTo(new LoggerFromEnv.Err(
        "KINDGI_LOG_LEVELS: \"pack\" isn't subsystem=level (levels: error, warn, info, debug, trace)."));
    assertThat(builder().fromEnv(Map.of("KINDGI_LOG_FORMAT", "xml"), false, null)).isEqualTo(new LoggerFromEnv.Err(
        "KINDGI_LOG_FORMAT must be auto, json or pretty, got \"xml\"."));
  }

  @Test
  void autoIsPrettyOnATerminalOrInDevelopmentAndJsonOtherwise() {
    assertThat(LogFormat.resolve(null, false, false)).isEqualTo(LogFormat.JSON);
    assertThat(LogFormat.resolve("auto", true, false)).isEqualTo(LogFormat.PRETTY);
    assertThat(LogFormat.resolve(" ", false, true)).isEqualTo(LogFormat.PRETTY);
    assertThat(LogFormat.resolve("JSON", true, true)).isEqualTo(LogFormat.JSON);
    assertThat(LogFormat.resolve("text", false, false)).isNull();
    LoggerFromEnv dev = builder().fromEnv(Map.of("KINDGI_DEV", "1"), false, null);
    ((LoggerFromEnv.Ok) dev).logger().info("hello");
    assertThat(lines.get(0)).isEqualTo("12:34:56.789 INFO  [pack] hello");
  }

  @Test
  void levelsParse() {
    assertThat(LogLevel.parse(" Warn ")).isEqualTo(LogLevel.WARN);
    assertThat(LogLevel.parse("warning")).isNull();
    assertThat(LogLevel.parseLevels(" a=debug, ,b.c=error ")).containsExactly(
        Map.entry("a", LogLevel.DEBUG), Map.entry("b.c", LogLevel.ERROR));
    assertThatThrownBy(() -> LogLevel.parseLevels("=debug")).hasMessageContaining("\"=debug\"");
    assertThat(LogLevel.levelFor("kernel.sweeper.x", Map.of("kernel", LogLevel.DEBUG), LogLevel.INFO))
        .isEqualTo(LogLevel.DEBUG);
  }

  @Test
  void knownSecretShapesAreScrubbedAndIdsAreNot() {
    assertThat(Redaction.scrubText("authorization: bearer abc.def; next")).isEqualTo("authorization: bearer [redacted]; next");
    assertThat(Redaction.scrubText("https://ada:p%40ss@host/x and run 1a2b")).isEqualTo("https://ada:***@host/x and run 1a2b");
    assertThat(Redaction.scrubText("kgi_pt_$0123456789abcdef")).isEqualTo("kgi_pt_$0123456789abcdef");
    assertThat(Redaction.isSecretKey("promptTokens", List.of())).isFalse();
    assertThat(Redaction.isSecretKey("X-Api-Key", List.of())).isTrue();
  }
}
