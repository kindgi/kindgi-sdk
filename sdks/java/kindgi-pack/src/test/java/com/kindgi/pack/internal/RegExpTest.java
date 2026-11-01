// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import org.junit.jupiter.api.Test;

/** Whether {@link RegExp} refuses a pattern, and says why, as Node 22 does. */
class RegExpTest {
  /** The regular-expression test vectors (packages/specs/test-vectors/README.md). */
  private static final Path VECTORS = Path.of("../../../packages/specs/test-vectors/regexp-syntax");

  private static String u(String source) {
    return RegExp.problem(source, true);
  }

  private static String plain(String source) {
    return RegExp.problem(source, false);
  }

  @Test
  void theUFlagRefusesWhatPlainModeReadsAsALetter() {
    assertThat(plain("\\a")).isNull();
    assertThat(u("\\a")).isEqualTo("Invalid escape");
    assertThat(plain("a{1")).isNull();
    assertThat(u("a{1")).isEqualTo("Incomplete quantifier");
    assertThat(u("]")).isEqualTo("Lone quantifier brackets");
    assertThat(plain("\\p{letter}")).isNull();
    assertThat(u("\\p{letter}")).isEqualTo("Invalid property name");
  }

  @Test
  void plainModeStillRefusesStructure() {
    assertThat(plain("(a")).isEqualTo("Unterminated group");
    assertThat(plain("a)")).isEqualTo("Unmatched ')'");
    assertThat(plain("a**")).isEqualTo("Nothing to repeat");
    assertThat(plain("a{2,1}")).isEqualTo("numbers out of order in {} quantifier");
    assertThat(plain("[z-a]")).isEqualTo("Range out of order in character class");
    assertThat(plain("(?i:a)")).isEqualTo("Invalid group");
    assertThat(plain("a\\")).isEqualTo("\\ at end of pattern");
  }

  @Test
  void aNamedGroupMakesKAReferenceInEitherMode() {
    assertThat(plain("\\k<a>")).isNull();
    assertThat(u("\\k<a>")).isEqualTo("Invalid named capture referenced");
    assertThat(plain("(?<b>.)\\k<a>")).isEqualTo("Invalid named capture referenced");
    assertThat(plain("(?<a>.)\\k")).isEqualTo("Invalid named reference");
    assertThat(plain("(?<a>.)[\\k]")).isEqualTo("Invalid escape");
  }

  @Test
  void referencesAreCheckedAfterTheRest() {
    assertThat(u("\\k<a>(?<a>.)")).isNull();
    assertThat(u("(?<a>.)\\k<b>(")).isEqualTo("Unterminated group");
  }

  @Test
  void aRepeatedNameIsRefusedOnceBothGroupsClose() {
    assertThat(plain("(?<a>.)|(?<a>.)")).isEqualTo("Duplicate capture group name");
    assertThat(plain("(?<a>.)(?<a>.")).isEqualTo("Unterminated group");
  }

  @Test
  void onlyTheUFlagRefusesARepeatedLookahead() {
    assertThat(plain("(?=a)*")).isNull();
    assertThat(u("(?=a)*")).isEqualTo("Invalid quantifier");
    assertThat(plain("(?<=a)*")).isEqualTo("Invalid quantifier");
  }

  @Test
  void theUFlagReadsASurrogatePairAsOneCharacter() {
    assertThat(u("[\uD83D\uDE00-\uD83D\uDE01]")).isNull();
    assertThat(plain("[\uD83D\uDE00-\uD83D\uDE01]")).isEqualTo("Range out of order in character class");
    // A group name is read by code points in either mode.
    assertThat(plain("(?<\uD835\uDC9C>.)")).isNull();
  }

  @Test
  void aPropertyNameIsReadByTheLowByteOfEachCharacter() {
    // U+0141 ends in 0x41 ("A"), so this is \p{Any}; U+0175 ends in 0x75 ("u"), so \p{Lu}.
    assertThat(u("\\p{\u0141ny}")).isNull();
    assertThat(u("\\p{L\u0175}")).isNull();
    assertThat(u("\\p{L\u0100}")).isEqualTo("Invalid property name");
  }

  @Test
  void captureGroupsStopAt32767() {
    assertThat(u("()".repeat(32767))).isNull();
    assertThat(u("()".repeat(32768))).isEqualTo("Too many captures");
    assertThat(plain("()".repeat(32768))).isEqualTo("Too many captures");
  }

  @SuppressWarnings("unchecked")
  private static String source(Object value) {
    if (value instanceof String s) {
      return s;
    }
    StringBuilder out = new StringBuilder();
    for (Object part : (List<Object>) value) {
      if (part instanceof String s) {
        out.append(s);
      } else {
        List<Object> counted = (List<Object>) part;
        out.append(((String) counted.get(0)).repeat(((Number) counted.get(1)).intValue()));
      }
    }
    return out.toString();
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> vectors(String file) throws IOException {
    return (Map<String, Object>) Json.parse(Files.readAllBytes(VECTORS.resolve(file)));
  }

  @Test
  @SuppressWarnings("unchecked")
  void everyVectorGetsNodesWordForWord() throws IOException {
    Map<String, Object> corpus = vectors("corpus.json");
    Map<String, Object> answers = vectors("answers.json");
    assertThat(List.copyOf(corpus.keySet())).isEqualTo(List.copyOf(answers.keySet()));
    List<String> mismatches = new ArrayList<>();
    Set<Object> plainReasons = new TreeSet<>();
    Set<Object> unicodeReasons = new TreeSet<>();
    for (Map.Entry<String, Object> c : corpus.entrySet()) {
      String source = source(c.getValue());
      Map<String, Object> said = (Map<String, Object>) answers.get(c.getKey());
      String unicode = u(source);
      String plain = plain(source);
      if (said.get("u") != null) {
        unicodeReasons.add(said.get("u"));
      }
      if (said.get("plain") != null) {
        plainReasons.add(said.get("plain"));
      }
      if (!Objects.equals(unicode, said.get("u")) || !Objects.equals(plain, said.get("plain"))) {
        mismatches.add(c.getKey() + "\n   node u " + said.get("u") + ", plain " + said.get("plain") + "\n   java u " + unicode + ", plain " + plain);
      }
    }
    assertThat(corpus).hasSizeGreaterThan(300);
    assertThat(mismatches).isEmpty();
    // The corpus gives every reason the check can.
    assertThat(plainReasons).hasSize(16);
    assertThat(unicodeReasons).hasSize(23);
  }
}
