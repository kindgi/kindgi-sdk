// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import static org.assertj.core.api.Assertions.assertThat;

import com.kindgi.pack.internal.Json;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * An agent's and a flow's own version is an exact semver with no build metadata, and a tool's is
 * MAJOR.MINOR.PATCH: another is an error of its file. The pack is the classes under {@code
 * testpacks/versions}, found by a source file of each.
 */
class IndexerVersionTest {
  private static final String SOURCES = "src/main/java/com/kindgi/pack/testpacks/versions/";

  @TempDir Path pack;

  @SuppressWarnings("unchecked")
  private Map<String, Object> index() throws Exception {
    Files.writeString(pack.resolve("kindgi.config.json"),
        "{\"language\": \"java\", \"pack\": {\"id\": \"acme\", \"version\": \"2.0.0\"}}");
    for (String file : List.of("agents/Agents.java", "flows/Flows.java", "tools/Tools.java")) {
      Path source = pack.resolve(SOURCES + file);
      Files.createDirectories(source.getParent());
      Files.writeString(source, "");
    }
    Map<String, Object> outcome = Indexer.run(pack, null, pack.resolve("dist/index.json"), "20261001.7",
        "2026-10-01T12:00:00.000Z", IndexerVersionTest.class.getClassLoader());
    assertThat(outcome.get("kind")).as(Json.compactString(outcome)).isEqualTo("ok");
    return (Map<String, Object>) outcome.get("value");
  }

  @SuppressWarnings("unchecked")
  private static List<String> errorsOf(Map<String, Object> report, String file) {
    return ((List<Map<String, Object>>) report.get("fileErrors")).stream()
        .filter(e -> (SOURCES + file).equals(e.get("filePath")))
        .map(e -> e.get("code") + ": " + e.get("message"))
        .sorted()
        .collect(Collectors.toList());
  }

  private static String refused(String file, String kind, String id, String version) {
    String rule = kind.equals("tool") ? "MAJOR.MINOR.PATCH (e.g. 1.2.3)"
        : "an exact semver with no build metadata (e.g. 1.2.3 or 1.2.3-rc.1)";
    return "manifest-validation-failed: " + SOURCES + file + ": " + kind + " '" + id + "': version must be " + rule
        + ", got '" + version + "'";
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> versions(Map<String, Object> index, String kind) {
    return ((List<Map<String, Object>>) index.get(kind)).stream()
        .collect(Collectors.toMap(e -> (String) e.get("id"), e -> e.get("version")));
  }

  @Test
  void aVersionOutsideItsKindsRuleIsAnErrorOfItsFile() throws Exception {
    Map<String, Object> report = index();
    assertThat(errorsOf(report, "agents/Agents.java")).containsExactly(
        refused("agents/Agents.java", "agent", "acme.build", "1.0.0+build.5"),
        refused("agents/Agents.java", "agent", "acme.leading-zero", "01.0.0"),
        refused("agents/Agents.java", "agent", "acme.prefixed", "v1.0.0"),
        refused("agents/Agents.java", "agent", "acme.short", "0.1"),
        refused("agents/Agents.java", "agent", "acme.trailing", "1.0.0 beta"));
    assertThat(errorsOf(report, "flows/Flows.java")).satisfiesExactly(
        leadingZero -> assertThat(leadingZero).isEqualTo(
            refused("flows/Flows.java", "flow", "acme.leading-zero-flow", "01.0.0")),
        shortFlow -> assertThat(shortFlow).startsWith("manifest-validation-failed: " + SOURCES + "flows/Flows.java: "
            + "flow 'acme.short-flow' is invalid at /version: must match pattern"));
    assertThat(errorsOf(report, "tools/Tools.java")).containsExactly(
        refused("tools/Tools.java", "tool", "acme.leading-zero-tool", "01.0.0"),
        refused("tools/Tools.java", "tool", "acme.prerelease-tool", "2.1.0-rc.1"),
        refused("tools/Tools.java", "tool", "acme.short-tool", "1.0"));
    assertThat(report.get("counts")).isEqualTo(Map.of("tools", 2, "guardrails", 0, "agents", 2, "flows", 1, "blocks", 0));
  }

  @Test
  @SuppressWarnings("unchecked")
  void aVersionInItsKindsRuleIndexesAndAToolWithoutOneTakesThePacks() throws Exception {
    Map<String, Object> report = index();
    Map<String, Object> index = (Map<String, Object>) Json.parse(Files.readAllBytes(Path.of((String) report.get("outputPath"))));
    assertThat(versions(index, "agents")).isEqualTo(Map.of("acme.plain", "1.0.0", "acme.prerelease", "1.0.0-rc.1"));
    assertThat(versions(index, "flows")).isEqualTo(Map.of("acme.plain-flow", "1.0.0"));
    assertThat(versions(index, "tools")).isEqualTo(Map.of("acme.own", "2.1.0", "acme.packs", "2.0.0"));
  }
}
