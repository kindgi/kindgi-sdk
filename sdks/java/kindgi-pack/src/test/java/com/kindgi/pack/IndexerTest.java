// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import static org.assertj.core.api.Assertions.assertThat;

import com.kindgi.pack.internal.CanonicalJson;
import com.kindgi.pack.internal.Json;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The indexer on the test packs ({@code src/test/resources/packs}), whose classes are test classes. */
class IndexerTest {
  @TempDir Path out;

  private static Path pack(String name) throws URISyntaxException {
    return Path.of(IndexerTest.class.getResource("/packs/" + name).toURI());
  }

  private Map<String, Object> index(String name) throws Exception {
    return Indexer.run(pack(name), null, out.resolve(name + ".json"), "20261001.7", "2026-10-01T12:00:00.000Z",
        IndexerTest.class.getClassLoader());
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> value(Map<String, Object> outcome) {
    assertThat(outcome.get("kind")).as(Json.compactString(outcome)).isEqualTo("ok");
    return (Map<String, Object>) outcome.get("value");
  }

  @Test
  @SuppressWarnings("unchecked")
  void aPackIndexesToCanonicalBytes() throws Exception {
    Map<String, Object> report = value(index("good"));
    assertThat(report.get("fileErrors")).isEqualTo(List.of());
    assertThat(report.get("counts")).isEqualTo(Map.of("tools", 2, "guardrails", 1, "agents", 1, "flows", 1));
    String text = Files.readString(out.resolve("good.json"), StandardCharsets.UTF_8);
    Map<String, Object> index = (Map<String, Object>) Json.parse(text.getBytes(StandardCharsets.UTF_8));
    assertThat(text).isEqualTo(CanonicalJson.stable(index) + "\n");
    assertThat(index.get("env")).isEqualTo(Map.of("required", List.of("DATABASE_URL"), "optional", List.of("SENTRY_DSN")));

    List<Map<String, Object>> tools = (List<Map<String, Object>>) index.get("tools");
    // Two versions of one tool, side by side; the re-exported one isn't this pack's.
    assertThat(tools).extracting(t -> t.get("id") + "@" + t.get("version")).containsExactly("acme.greet@1.0.0", "acme.greet@2.0.0");
    assertThat(tools.get(0)).containsEntry("mutating", false)
        .containsEntry("modulePath", "src/main/java/com/kindgi/pack/testpacks/good/tools/Greet.java")
        .containsEntry("input", Map.of("type", "object", "additionalProperties", false,
            "properties", Map.of("name", Map.of("type", "string")), "required", List.of("name")));
    assertThat(tools.get(1).get("effects")).isEqualTo(List.of(Map.of("kind", "network", "resource", "api:greetings")));

    Map<String, Object> guardrail = ((List<Map<String, Object>>) index.get("guardrails")).get(0);
    assertThat(guardrail).containsEntry("checkId", "acme.checks.not-empty").containsEntry("kind", "zero-llm")
        .containsEntry("action", Map.of("on-violation", "retry"))
        .containsEntry("checkModulePath", "src/main/java/com/kindgi/pack/testpacks/good/guardrails/Checks.java");

    Map<String, Object> agent = ((List<Map<String, Object>>) index.get("agents")).get(0);
    assertThat(agent.get("tools")).isEqualTo(List.of(
        Map.of("id", "acme.greet", "version", "1.0.0"), Map.of("id", "other.tool", "version", "^1.0.0")));
    assertThat(agent.get("guardrails")).isEqualTo(List.of("acme.not-empty"));
    assertThat(((Map<String, Object>) agent.get("output")).get("schema")).isEqualTo(Map.of("type", "object",
        "additionalProperties", false, "properties", Map.of("text", Map.of("type", "string")), "required", List.of("text")));

    Map<String, Object> flow = ((List<Map<String, Object>>) index.get("flows")).get(0);
    assertThat(flow.get("nodes")).isEqualTo(List.of(Map.of("id", "greet", "kind", "tool", "ref", "acme.greet")));
    // An edge's condition and policy, as written.
    assertThat(flow.get("edges")).isEqualTo(List.of(
        Map.of("id", "e1", "from", "$start", "to", "greet", "policy", Map.of("retry", Map.of("maxAttempts", 2))),
        Map.of("id", "e2", "from", "greet", "to", "$end",
            "when", Map.of("op", "exists", "value", Map.of("path", "nodeOutputs.greet.message")))));
    assertThat(flow).containsEntry("kernelPayloadVersion", 1);
  }

  @Test
  void theSameClassesIndexToTheSameBytes() throws Exception {
    value(index("good"));
    byte[] first = Files.readAllBytes(out.resolve("good.json"));
    value(index("good"));
    assertThat(Files.readAllBytes(out.resolve("good.json"))).isEqualTo(first);
  }

  @Test
  @SuppressWarnings("unchecked")
  void everyBadFileIsItsOwnErrorAndTheRestIndexes() throws Exception {
    Map<String, Object> report = value(index("bad"));
    Map<String, String> errors = ((List<Map<String, Object>>) report.get("fileErrors")).stream()
        .collect(Collectors.toMap(
            e -> String.valueOf(e.get("filePath")).replaceAll(".*/", ""),
            e -> e.get("code") + ": " + e.get("message"),
            (a, b) -> a + " | " + b));
    assertThat(errors.get("Misplaced.java")).startsWith("kind-mismatch: ").contains("is in a tools package")
        .contains("defines a 'guardrail' (acme.misplaced)");
    assertThat(errors.get("Empty.java")).startsWith("no-primitives: ");
    assertThat(errors.get("Boom.java")).startsWith("file-import-failed: ").contains("java.lang.IllegalStateException: no database");
    assertThat(errors.get("Ghost.java")).startsWith("file-import-failed: ").contains("isn't on the classpath");
    assertThat(errors.get("Recursive.java")).startsWith("manifest-validation-failed: ").contains("tool 'acme.recursive' input")
        .contains("refers to itself");
    assertThat(errors.get("Unsupported.java")).startsWith("manifest-validation-failed: ").contains("tool 'acme.unsupported' input")
        .contains("if");
    assertThat(errors.get("Dup2.java")).isEqualTo("manifest-validation-failed: src/main/java/com/kindgi/pack/testpacks/bad/tools/Dup2.java: "
        + "duplicate tool 'acme.dup' version 1.0.0 (also defined in src/main/java/com/kindgi/pack/testpacks/bad/tools/Dup.java)");
    assertThat(errors.get("Unknown.java")).startsWith("manifest-validation-failed: ").contains("tool 'acme.unknown' is invalid at /")
        .contains("('colour')");
    assertThat(errors.get("BadFlow.java")).contains("flow 'acme.bad-flow' is invalid at /nodes/0/kind: must be one of ");
    assertThat(errors).doesNotContainKey("Dup.java");
    assertThat(report.get("counts")).isEqualTo(Map.of("tools", 1, "guardrails", 0, "agents", 0, "flows", 0));
    Map<String, Object> boom = ((List<Map<String, Object>>) report.get("fileErrors")).stream()
        .filter(e -> String.valueOf(e.get("filePath")).endsWith("Boom.java")).findFirst().orElseThrow();
    assertThat((Map<String, Object>) boom.get("cause")).containsEntry("name", "java.lang.IllegalStateException")
        .containsEntry("message", "no database").containsKey("stack");
  }

  @Test
  @SuppressWarnings("unchecked")
  void aScalaPackIndexesItsObjectsVals() throws Exception {
    Map<String, Object> report = value(index("scala"));
    Map<String, String> errors = ((List<Map<String, Object>>) report.get("fileErrors")).stream()
        .collect(Collectors.toMap(
            e -> String.valueOf(e.get("filePath")).replaceAll(".*/", ""),
            e -> e.get("code") + ": " + e.get("message")));
    // A class with no object, and a companion with no primitives, are helpers; a test is no source.
    assertThat(errors).containsOnlyKeys("Lazy.scala", "Ghost.scala");
    assertThat(errors.get("Lazy.scala")).isEqualTo("no-primitives: File src/main/scala/com/kindgi/pack/testpacks/scalalike/"
        + "tools/Lazy.scala: object Lazy defines tool as a def or a lazy val, which the indexer can't read without running"
        + " it; make it a val");
    assertThat(errors.get("Ghost.scala")).isEqualTo("file-import-failed: Failed to load src/main/scala/com/kindgi/pack/"
        + "testpacks/scalalike/tools/Ghost.scala: object Ghost (class com.kindgi.pack.testpacks.scalalike.tools.Ghost$)"
        + " isn't on the classpath. A Scala file's tools, guardrails, agents and flows are vals of an object named like"
        + " the file (compile the pack first)");

    String text = Files.readString(out.resolve("scala.json"), StandardCharsets.UTF_8);
    Map<String, Object> index = (Map<String, Object>) Json.parse(text.getBytes(StandardCharsets.UTF_8));
    List<Map<String, Object>> tools = (List<Map<String, Object>>) index.get("tools");
    // Built through the Scala layer's package, the tool is still defined in the object.
    assertThat(tools).singleElement().satisfies(t -> assertThat(t)
        .containsEntry("id", "acme.scala-greet")
        .containsEntry("modulePath", "src/main/scala/com/kindgi/pack/testpacks/scalalike/tools/Greet.scala"));

    // The service finds it where the index says.
    String path = (String) tools.get(0).get("modulePath");
    assertThat(PackService.classOf(path)).isEqualTo("com.kindgi.pack.testpacks.scalalike.tools.Greet$");
    assertThat(PackService.missingModules(index, IndexerTest.class.getClassLoader())).isEmpty();
    assertThat(Indexer.primitivesOf(Class.forName(PackService.classOf(path))))
        .singleElement().isInstanceOf(Tool.class);
  }

  @Test
  @SuppressWarnings("unchecked")
  void configAndDiscoveryProblemsAreTheOutcome(@TempDir Path dir) throws Exception {
    Map<String, Object> missing = Indexer.run(dir, null, null, null, null, getClass().getClassLoader());
    assertThat(missing.get("kind")).isEqualTo("err");
    assertThat((Map<String, Object>) missing.get("error")).containsEntry("code", "config-not-found");

    Files.writeString(dir.resolve("kindgi.config.json"), "{\"language\": \"java\", \"pack\": {\"id\": \"acme\", \"version\": \"1.0.0\"}}");
    Map<String, Object> empty = Indexer.run(dir, null, null, null, null, getClass().getClassLoader());
    assertThat((Map<String, Object>) empty.get("error")).containsEntry("code", "discovery-empty");
    assertThat(String.valueOf(((Map<String, Object>) empty.get("error")).get("message"))).contains("kindgi.config.json");
  }

  @Test
  @SuppressWarnings("unchecked")
  void withoutAPinTheArtifactVersionCountsUpWithinADay() throws Exception {
    Path output = out.resolve("auto.json");
    ClassLoader loader = getClass().getClassLoader();
    String first = (String) value(Indexer.run(pack("good"), null, output, null, null, loader)).get("artifactVersion");
    String second = (String) value(Indexer.run(pack("good"), null, output, null, null, loader)).get("artifactVersion");
    assertThat(first).matches("[0-9]{8}\\.1");
    assertThat(second).isEqualTo(first.replaceAll("\\.1$", ".2"));
    assertThat((String) value(Indexer.run(pack("good"), null, output, null, null, loader)).get("publishedAt"))
        .matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z");
  }

  @Test
  void theCommandLinePrintsOneJsonLine() throws Exception {
    java.io.ByteArrayOutputStream stdout = new java.io.ByteArrayOutputStream();
    java.io.ByteArrayOutputStream stderr = new java.io.ByteArrayOutputStream();
    int code = Main.run(List.of("index", "--pack-dir", pack("good").toString(), "--output", out.resolve("cli.json").toString(),
        "--artifact-version", "20261001.7", "--published-at", "2026-10-01T12:00:00.000Z", "--json"),
        new java.io.PrintStream(stdout, true, StandardCharsets.UTF_8), new java.io.PrintStream(stderr, true, StandardCharsets.UTF_8));
    assertThat(code).isEqualTo(0);
    String line = stdout.toString(StandardCharsets.UTF_8);
    assertThat(line).startsWith("{\"kind\":\"ok\",\"value\":{\"packId\":\"acme\"").endsWith("}\n").hasLineCount(1);
    assertThat(Main.run(List.of("index"), System.out, new java.io.PrintStream(stderr, true, StandardCharsets.UTF_8))).isEqualTo(2);
    assertThat(stderr.toString(StandardCharsets.UTF_8)).contains("--pack-dir is required");
  }
}
