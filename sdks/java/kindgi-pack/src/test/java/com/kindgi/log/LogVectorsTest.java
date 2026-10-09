// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.log;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BiFunction;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

/**
 * The shared record vectors ({@code packages/log/tests/vectors/records.json}): the logger writes
 * each case's record exactly, keys in order, or nothing when the case expects {@code null}. {@code
 * @kindgi/log} and Python's {@code kindgi.log} replay the same file, so the languages write the same
 * records and redact the same way.
 */
class LogVectorsTest {
  private static final Path VECTORS = Path.of("../../../packages/log/tests/vectors/records.json");
  private static final ObjectMapper JSON = new ObjectMapper();

  /** A JavaScript {@code TypeError}, as a Java error: its simple name is the record's {@code name}. */
  static final class TypeError extends RuntimeException {
    private static final long serialVersionUID = 1L;
    private final String code;

    TypeError(String message, String code) {
      super(message);
      this.code = code;
    }

    public String code() {
      return code;
    }
  }

  /** The vectors' error names, as Java errors. A new name in the vectors needs a class here. */
  private static final Map<String, BiFunction<String, String, RuntimeException>> ERRORS =
      Map.of("TypeError", TypeError::new);

  @TestFactory
  @SuppressWarnings("unchecked")
  Stream<DynamicTest> theSharedRecordVectors() throws IOException {
    assertThat(VECTORS).as("the vectors, from sdks/java/kindgi-pack").exists();
    Map<String, Object> spec = JSON.readValue(Files.readAllBytes(VECTORS), new TypeReference<LinkedHashMap<String, Object>>() {});
    Clock clock = Clock.fixed(Instant.parse((String) spec.get("now")), ZoneOffset.UTC);
    List<Map<String, Object>> cases = (List<Map<String, Object>>) spec.get("cases");
    return cases.stream().map(c -> DynamicTest.dynamicTest((String) c.get("name"), () -> replay(c, clock)));
  }

  @SuppressWarnings("unchecked")
  private static void replay(Map<String, Object> c, Clock clock) throws IOException {
    Map<String, Object> config = (Map<String, Object>) c.get("logger");
    Map<String, LogLevel> levels = new LinkedHashMap<>();
    ((Map<String, String>) config.getOrDefault("levels", Map.of())).forEach((k, v) -> levels.put(k, LogLevel.parse(v)));
    List<String> lines = new ArrayList<>();
    Logger log = Logger.builder()
        .level(LogLevel.parse((String) config.get("level")))
        .levels(levels)
        .format(LogFormat.JSON)
        .write(lines::add)
        .clock(clock)
        .build();
    for (Map<String, Object> b : (List<Map<String, Object>>) c.get("bindings")) {
      log = log.child(b);
    }
    Map<String, Object> fields = new LinkedHashMap<>((Map<String, Object>) c.get("fields"));
    Map<String, String> error = (Map<String, String>) c.get("error");
    if (error != null) {
      assertThat(ERRORS).as("a Java error named " + error.get("name")).containsKey(error.get("name"));
      fields.put("err", ERRORS.get(error.get("name")).apply(error.get("message"), error.get("code")));
    }
    List<String> inMessage = (List<String>) c.get("inMessage");
    LogOptions options = inMessage == null ? LogOptions.NONE : new LogOptions(inMessage);
    log.log(LogLevel.parse((String) c.get("level")), (String) c.get("message"), fields, options);
    Object expected = c.get("expected");
    if (expected == null) {
      assertThat(lines).isEmpty();
      return;
    }
    assertThat(lines).hasSize(1);
    Map<String, Object> got = JSON.readValue(lines.get(0), new TypeReference<LinkedHashMap<String, Object>>() {});
    assertThat(got).isEqualTo(expected);
    assertThat(new ArrayList<>(got.keySet())).isEqualTo(new ArrayList<>(((Map<String, Object>) expected).keySet()));
  }
}
