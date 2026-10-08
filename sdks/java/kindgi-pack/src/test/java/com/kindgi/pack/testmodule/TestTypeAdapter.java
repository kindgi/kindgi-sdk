// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testmodule;

import com.fasterxml.jackson.databind.JavaType;
import com.fasterxml.jackson.databind.introspect.BeanPropertyDefinition;
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
  public @Nullable Map<String, Object> schema(JavaType type, Function<JavaType, Map<String, Object>> derive) {
    if (type.getRawClass() == Money.class) {
      Map<String, Object> s = new LinkedHashMap<>();
      s.put("type", "string");
      s.put("pattern", "^[0-9]+\\.[0-9]{2} [A-Z]{3}$");
      return s;
    }
    if (type.getRawClass() == Bag.class) {
      Map<String, Object> s = new LinkedHashMap<>();
      s.put("type", "array");
      s.put("items", derive.apply(type.containedTypeOrUnknown(0)));
      return s;
    }
    return null;
  }

  @Override
  public @Nullable JavaType optionalOf(JavaType type) {
    return type.getRawClass() == Maybe.class ? type.containedTypeOrUnknown(0) : null;
  }

  @Override
  public Optional<Object> defaultValue(Class<?> owner, BeanPropertyDefinition property) {
    // By creator position, as Scala's defaults are found: currency is the record's second component.
    int index = property.getConstructorParameter() == null ? -1 : property.getConstructorParameter().getIndex();
    if (owner == Priced.class && index == 1) {
      return Optional.of("EUR");
    }
    if (owner == Priced.class && property.getName().equals("tag")) {
      return Optional.of(new Tag("none"));
    }
    return Optional.empty();
  }
}
