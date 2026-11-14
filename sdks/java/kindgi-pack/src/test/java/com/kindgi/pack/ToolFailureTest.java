// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/** A tool's own failure, as in the TypeScript and Python packs: its code, its words, its details. */
class ToolFailureTest {
  @Test
  void keepsItsCodeItsMessageAsWrittenAndAJsonCopyOfItsDetails() {
    Map<String, Object> given = new LinkedHashMap<>();
    given.put("orderId", "Z-9");
    given.put("lines", List.of(1, 2));
    ToolFailureException failure = new ToolFailureException("order-not-found", "No order Z-9", given);
    assertThat(failure.code()).isEqualTo("order-not-found");
    assertThat(failure.getMessage()).isEqualTo("No order Z-9");
    assertThat(failure.details()).isEqualTo(Map.of("orderId", "Z-9", "lines", List.of(1, 2)));
    given.put("orderId", "Z-10");
    assertThat(failure.details()).containsEntry("orderId", "Z-9");
    assertThat(ToolFailureException.CODE).isEqualTo("tool-failed");
  }

  @Test
  void hasNoDetailsWhenItWasGivenNone() {
    assertThat(new ToolFailureException("order-not-found", "No order Z-9").details()).isNull();
  }

  @Test
  void cutsItsMessageAt1000CharactersWithoutSplittingAPair() {
    assertThat(new ToolFailureException("too-long", "x".repeat(1500)).getMessage()).hasSize(1000);
    String cut = new ToolFailureException("too-long", "x".repeat(999) + "😀😀").getMessage();
    assertThat(cut.codePointCount(0, cut.length())).isEqualTo(1000);
    assertThat(cut).endsWith("😀");
  }

  @ParameterizedTest
  @ValueSource(strings = {"Order-Not-Found", "9-orders", "order_not_found", ""})
  void refusesACodeThatIsntKebabCase(String code) {
    assertThatThrownBy(() -> new ToolFailureException(code, "No order Z-9"))
        .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("kebab case");
  }

  @Test
  void refusesA65CharacterCodeAndTakes64() {
    assertThatThrownBy(() -> new ToolFailureException("a" + "b".repeat(64), "No order Z-9"))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(new ToolFailureException("a" + "b".repeat(63), "No order Z-9").code()).hasSize(64);
  }

  @ParameterizedTest
  @ValueSource(strings = {"", "   "})
  void refusesAnEmptyMessage(String message) {
    assertThatThrownBy(() -> new ToolFailureException("order-not-found", message))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessage("ToolFailureException \"order-not-found\" needs a message for a person");
  }

  @Test
  void refusesDetailsThatArentJson() {
    assertThatThrownBy(() -> new ToolFailureException("order-not-found", "No order Z-9", Map.of("ratio", Double.NaN)))
        .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("details aren't JSON");
  }

  @Test
  void takesItsDetailsAsJsonDoes() {
    Instant at = Instant.parse("2026-11-06T12:00:00Z");
    assertThat(new ToolFailureException("order-not-found", "No order Z-9", Map.of("at", at)).details())
        .containsOnlyKeys("at");
  }

  @Test
  void refusesDetailsOfMoreThan4KibAsJsonAndTakes4KibExactly() {
    // {"note":"…"} is 11 bytes around the note.
    Map<String, Object> exactly = Map.of("note", "x".repeat(4096 - 11));
    assertThat(new ToolFailureException("too-big", "No order Z-9", exactly).details()).isEqualTo(exactly);
    assertThatThrownBy(() -> new ToolFailureException("too-big", "No order Z-9", Map.of("note", "x".repeat(4097 - 11))))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessage("ToolFailureException \"too-big\"'s details take 4097 bytes as JSON, more than 4096");
  }
}
