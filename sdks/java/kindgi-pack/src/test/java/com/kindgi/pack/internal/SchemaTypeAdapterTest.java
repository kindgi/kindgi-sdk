// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import static org.assertj.core.api.Assertions.assertThat;

import com.kindgi.pack.testmodule.Bag;
import com.kindgi.pack.testmodule.Maybe;
import com.kindgi.pack.testmodule.Money;
import com.kindgi.pack.testmodule.TestTypeAdapter;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * A language layer's {@code SchemaTypeAdapter} ({@code TestTypeAdapter}, from the test classpath's
 * {@code META-INF/services}): its types' schemas, its optional wrapper, its defaults.
 */
class SchemaTypeAdapterTest {
  record Order(Money total, Maybe<String> note, Bag<Maybe<Integer>> counts, @Size(max = 20) Money capped, Maybe<Money> tip) {}

  @Test
  void theAdapterIsFound() {
    assertThat(SchemaDeriver.adapters()).hasSize(1).first().isInstanceOf(TestTypeAdapter.class);
  }

  @Test
  void adaptedTypesWrappersAndConstraints() {
    Map<String, Object> money = Map.of("type", "string", "pattern", "^[0-9]+\\.[0-9]{2} [A-Z]{3}$");
    Map<String, Object> s = SchemaDeriver.schema(Order.class);
    assertThat(s).containsEntry("properties", Map.of(
        "total", money,
        "note", Map.of("type", List.of("string", "null")),
        "counts", Map.of("type", "array", "items", Map.of("type", "integer")),
        "capped", Map.of("type", "string", "pattern", "^[0-9]+\\.[0-9]{2} [A-Z]{3}$", "maxLength", 20L),
        "tip", Map.of("type", List.of("string", "null"), "pattern", "^[0-9]+\\.[0-9]{2} [A-Z]{3}$")));
    assertThat(s).containsEntry("required", List.of("total", "counts", "capped"));
  }

  @Test
  void defaultsAreSaidAsPlainJsonAndNotRequired() {
    Map<String, Object> s = SchemaDeriver.schema(TestTypeAdapter.Priced.class);
    @SuppressWarnings("unchecked")
    Map<String, Object> properties = (Map<String, Object>) s.get("properties");
    assertThat(properties).containsEntry("currency", Map.of("type", "string", "default", "EUR"));
    assertThat(properties.get("tag")).isEqualTo(Map.of("type", "object",
        "properties", Map.of("label", Map.of("type", "string")), "required", List.of("label"),
        "additionalProperties", false, "default", Map.of("label", "none")));
    assertThat(s).containsEntry("required", List.of("total"));
  }
}
