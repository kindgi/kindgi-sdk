// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.codegen;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * The generator's output for a small API document that uses every construct it supports, compared
 * with the reviewed output in {@code fixture/expected}. After an intended change, regenerate the
 * expected files with {@code ./mvnw -pl codegen test -Dkindgi.updateGolden=true} and review the
 * diff.
 */
class GoldenTest {
  private static final Path FIXTURE = Path.of("src/test/resources/fixture/openapi.json");
  private static final Path EXPECTED = Path.of("src/test/resources/fixture/expected");

  @Test
  void fixtureGeneratesTheReviewedSources() throws IOException {
    Map<String, String> actual = Generator.sources(Generator.read(FIXTURE)).files();
    if (Boolean.getBoolean("kindgi.updateGolden")) {
      Generator.write(actual, EXPECTED);
      return;
    }
    Map<String, String> expected = new TreeMap<>();
    try (Stream<Path> files = Files.walk(EXPECTED)) {
      for (Path p : (Iterable<Path>) files.filter(Files::isRegularFile)::iterator) {
        expected.put(EXPECTED.relativize(p).toString().replace('\\', '/'), Files.readString(p, StandardCharsets.UTF_8));
      }
    }
    assertThat(actual.keySet()).containsExactlyElementsOf(expected.keySet());
    for (Map.Entry<String, String> e : expected.entrySet()) {
      assertThat(actual.get(e.getKey())).as(e.getKey()).isEqualTo(e.getValue());
    }
  }

  @Test
  void generationIsDeterministic() {
    Map<String, Object> doc = Generator.read(FIXTURE);
    assertThat(Generator.sources(doc).files()).isEqualTo(Generator.sources(Generator.read(FIXTURE)).files());
  }

  @Test
  void writeOnlyTouchesChangedFilesAndRemovesStaleOnes(@org.junit.jupiter.api.io.TempDir Path out) throws IOException {
    Map<String, String> sources = Generator.sources(Generator.read(FIXTURE)).files();
    Files.createDirectories(out.resolve("com/kindgi/client/models"));
    Files.writeString(out.resolve("com/kindgi/client/models/Stale.java"), "// gone");
    assertThat(Generator.write(sources, out)).containsExactly(sources.size(), 1);
    assertThat(Generator.write(sources, out)).containsExactly(0, 0);
    assertThat(out.resolve("com/kindgi/client/models/Stale.java")).doesNotExist();
  }
}
