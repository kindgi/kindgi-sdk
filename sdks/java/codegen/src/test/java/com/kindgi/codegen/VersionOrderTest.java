// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.codegen;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.apache.maven.artifact.versioning.ComparableVersion;
import org.junit.jupiter.api.Test;

/**
 * The JVM SDKs take the npm packages' version as npm spells it ({@code scripts/sync-jvm-version.mjs}),
 * which is right only while Maven orders every spelling that script accepts ({@code X.Y.Z}, or
 * {@code -alpha.N}, {@code -beta.N}, {@code -rc.N}) as npm does. This holds Maven to it.
 */
class VersionOrderTest {
  /** In npm's order, lowest first. */
  private static final List<String> NPM_ORDER = List.of(
      "0.1.6-alpha.0",
      "0.1.6-alpha.1",
      "0.1.6-alpha.10",
      "0.1.6-beta.0",
      "0.1.6-beta.2",
      "0.1.6-rc.0",
      "0.1.6-rc.1",
      "0.1.6-rc.9",
      "0.1.6-rc.10",
      "0.1.6",
      "0.1.7-rc.0",
      "0.1.7",
      "0.1.10",
      "0.2.0-rc.0",
      "0.2.0",
      "1.0.0-alpha.0",
      "1.0.0",
      "1.0.1",
      "1.10.0");

  @Test
  void mavenOrdersTheNpmSpellingAsNpmDoes() {
    for (int i = 1; i < NPM_ORDER.size(); i++) {
      ComparableVersion lower = new ComparableVersion(NPM_ORDER.get(i - 1));
      ComparableVersion higher = new ComparableVersion(NPM_ORDER.get(i));
      assertThat(lower).as("%s < %s", lower, higher).isLessThan(higher);
    }
  }
}
