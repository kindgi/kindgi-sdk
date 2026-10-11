// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testmodule;

import com.kindgi.pack.spi.SchemaProperty;
import com.kindgi.pack.spi.SchemaType;
import com.kindgi.pack.spi.SchemaTypeAdapter;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;
import org.jspecify.annotations.Nullable;

/**
 * A language layer's adapter, declared in the test classpath's {@code META-INF/services}: it knows
 * only this package's types, so every other test derives as before.
 */
public final class TestTypeAdapter implements SchemaTypeAdapter {
  /** Has properties with language-level defaults ({@code currency}, {@code tag}). */
  public record Priced(Money total, String currency, Tag tag) {}

  /** A default that is a typed value. */
  public record Tag(String label) {}

  @Override
  public @Nullable Map<String, Object> schema(SchemaType type, Function<SchemaType, Map<String, Object>> derive) {
    if (type.rawClass() == Money.class) {
      Map<String, Object> s = new LinkedHashMap<>();
      s.put("type", "string");
      s.put("pattern", "^[0-9]+\\.[0-9]{2} [A-Z]{3}$");
      return s;
    }
    if (type.rawClass() == Bag.class) {
      Map<String, Object> s = new LinkedHashMap<>();
      s.put("type", "array");
      s.put("items", derive.apply(type.typeArgument(0)));
      return s;
    }
    return null;
  }

  @Override
  public @Nullable SchemaType optionalOf(SchemaType type) {
    return type.rawClass() == Maybe.class ? type.typeArgument(0) : null;
  }

  @Override
  public Optional<Object> defaultValue(SchemaProperty property) {
    // By constructor position, as Scala's defaults are found: currency is the record's second component.
    if (property.declaringType() == Priced.class && property.constructorIndex().equals(java.util.OptionalInt.of(1))) {
      return Optional.of("EUR");
    }
    if (property.declaringType() == Priced.class && property.wireName().equals("tag")) {
      return Optional.of(new Tag("none"));
    }
    return Optional.empty();
  }
}
