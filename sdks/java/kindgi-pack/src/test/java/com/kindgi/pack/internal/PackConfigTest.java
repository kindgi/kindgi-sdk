// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

/** {@code kindgi.config.json}: its checks and messages, as Python's {@code [tool.kindgi]} has them. */
class PackConfigTest {
  @TempDir Path dir;

  private PackConfig load(String json) throws Exception {
    Files.writeString(dir.resolve("kindgi.config.json"), json);
    return PackConfig.load(dir, null);
  }

  @Test
  void aConfigWithDefaults() throws Exception {
    PackConfig config = load("{\"language\": \"java\", \"pack\": {\"id\": \"acme\", \"version\": \"1.0.0\", \"description\": \"d\"},"
        + " \"discovery\": {\"tools\": \"src/main/java/com/acme/kindgi/**/*.java\"}, \"dev\": {\"port\": 1}}");
    assertThat(config.id()).isEqualTo("acme");
    assertThat(config.description()).isEqualTo("d");
    assertThat(config.discovery()).containsEntry("tools", "src/main/java/com/acme/kindgi/**/*.java")
        .containsEntry("flows", "src/main/java/**/flows/**/*.java");
    assertThat(config.env()).isNull();
  }

  @Test
  void aScalaPacksDefaultsAreItsSources() throws Exception {
    PackConfig config = load("{\"language\": \"scala\", \"pack\": {\"id\": \"acme\", \"version\": \"1.0.0\"}}");
    assertThat(config.layout()).isEqualTo(SourceLayout.SCALA);
    assertThat(config.discovery()).containsExactly(
        Map.entry("tools", "src/main/scala/**/tools/**/*.scala"),
        Map.entry("guardrails", "src/main/scala/**/guardrails/**/*.scala"),
        Map.entry("agents", "src/main/scala/**/agents/**/*.scala"),
        Map.entry("flows", "src/main/scala/**/flows/**/*.scala"));
  }

  @Test
  void envIsCheckedAndSorted() throws Exception {
    PackConfig config = load("{\"language\": \"java\", \"pack\": {\"id\": \"acme\", \"version\": \"1.0.0\"},"
        + " \"env\": {\"required\": [\"B\", \"A\"], \"optional\": [\"Z_9\"]}}");
    assertThat(config.env().required()).containsExactly("A", "B");
    assertThat(config.env().optional()).containsExactly("Z_9");
  }

  @ParameterizedTest
  @CsvSource(delimiter = '|', quoteCharacter = '~', value = {
    "not json | config-parse-failed | Failed to read",
    "[] | config-parse-failed | must hold a JSON object",
    "{\"pack\": {\"id\": \"a\", \"version\": \"1\"}} | config-parse-failed | 'language' is missing",
    "{\"language\": \"python\", \"pack\": {\"id\": \"a\", \"version\": \"1\"}} | config-parse-failed | 'language' is \"python\"",
    "{\"language\": \"java\"} | config-parse-failed | 'pack' field is missing",
    "{\"language\": \"java\", \"pack\": {\"version\": \"1\"}} | config-parse-failed | 'pack.id' is missing",
    "{\"language\": \"java\", \"pack\": {\"id\": \"a\", \"version\": \"\"}} | config-parse-failed | 'pack.version' is missing",
    "{\"language\": \"java\", \"pack\": {\"id\": \"a\", \"version\": \"1\"}, \"discovery\": {\"tools\": 1}} | config-parse-failed | 'discovery' must map",
    "{\"language\": \"java\", \"pack\": {\"id\": \"a\", \"version\": \"1\"}, \"env\": [\"A\"]} | config-invalid | `env` must be an object",
    "{\"language\": \"java\", \"pack\": {\"id\": \"a\", \"version\": \"1\"}, \"env\": {\"needed\": []}} | config-invalid | not `needed`",
    "{\"language\": \"java\", \"pack\": {\"id\": \"a\", \"version\": \"1\"}, \"env\": {\"required\": [\"1A\"]}} | config-invalid | isn't an environment variable name",
    "{\"language\": \"java\", \"pack\": {\"id\": \"a\", \"version\": \"1\"}, \"env\": {\"required\": [\"KINDGI_X\"]}} | config-invalid | configure Kindgi, not the pack",
    "{\"language\": \"java\", \"pack\": {\"id\": \"a\", \"version\": \"1\"}, \"env\": {\"required\": [\"A\", \"A\"]}} | config-invalid | listed twice",
    "{\"language\": \"java\", \"pack\": {\"id\": \"a\", \"version\": \"1\"}, \"env\": {\"required\": [\"A\"], \"optional\": [\"A\"]}} | config-invalid | in both",
  })
  void problemsAreSaid(String json, String code, String message) {
    assertThatThrownBy(() -> load(json))
        .isInstanceOfSatisfying(PackConfig.ConfigException.class, e -> {
          assertThat(e.code()).isEqualTo(code);
          assertThat(e.getMessage()).contains(message);
        });
  }

  @Test
  void noConfig() {
    assertThatThrownBy(() -> PackConfig.load(dir, null))
        .isInstanceOfSatisfying(PackConfig.ConfigException.class, e -> assertThat(e.code()).isEqualTo("config-not-found"));
  }

  @Test
  void discoveryGlobs() throws Exception {
    assertThat(Discovery.globToRegex("src/main/java/**/tools/**/*.java").matcher("src/main/java/com/acme/tools/Greet.java").matches()).isTrue();
    assertThat(Discovery.globToRegex("src/main/java/**/tools/**/*.java").matcher("src/main/java/tools/a/b/X.java").matches()).isTrue();
    assertThat(Discovery.globToRegex("src/main/java/**/tools/**/*.java").matcher("src/main/java/com/acme/tool/X.java").matches()).isFalse();
    assertThat(Discovery.globToRegex("a/{b,c}/?.java").matcher("a/c/X.java").matches()).isTrue();
    assertThat(Discovery.globToRegex("a/*.java").matcher("a/b/X.java").matches()).isFalse();
    assertThat(Discovery.staticPrefix("src/main/java/**/tools/**/*.java")).isEqualTo("src/main/java");
    assertThat(Discovery.staticPrefix("./kindgi/X.java")).isEqualTo("kindgi");

    Path tools = Files.createDirectories(dir.resolve("src/main/java/com/acme/tools"));
    Files.writeString(tools.resolve("Greet.java"), "");
    Files.writeString(tools.resolve("GreetTest.java"), "");
    Files.writeString(tools.resolve(".Hidden.java"), "");
    Files.createDirectories(dir.resolve("src/test/java/com/acme/tools"));
    Files.writeString(dir.resolve("src/test/java/com/acme/tools/Probe.java"), "");
    Files.createDirectories(dir.resolve("target/classes/tools"));
    Files.writeString(dir.resolve("target/classes/tools/Copy.java"), "");
    assertThat(Discovery.discover(dir, "src/main/java/**/tools/**/*.java")).containsExactly("src/main/java/com/acme/tools/Greet.java");
    assertThat(Discovery.discover(dir, "**/tools/*.java")).isEqualTo(List.of("src/main/java/com/acme/tools/Greet.java"));
  }
}
