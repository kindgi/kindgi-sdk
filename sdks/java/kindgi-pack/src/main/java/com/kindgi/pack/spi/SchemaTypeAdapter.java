// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.spi;

import com.fasterxml.jackson.databind.JavaType;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;
import org.jspecify.annotations.Nullable;

/**
 * Teaches the schema deriver a language's own types: a JVM language layer (kindgi-pack-scala)
 * implements it and declares it in {@code META-INF/services/com.kindgi.pack.spi.SchemaTypeAdapter};
 * the deriver asks every adapter on the classpath before its own rules.
 *
 * <p>Each method has a default that knows nothing, so an adapter implements only what its language
 * needs. A type no adapter knows is derived as Java's. To refuse a type it knows but can't express (a
 * map whose keys aren't strings), {@link #schema} throws an {@code IllegalArgumentException} saying
 * why; the index names the property.
 */
public interface SchemaTypeAdapter {
  /**
   * A type's schema, when this adapter knows the type (Scala's {@code Seq}, {@code BigDecimal}).
   *
   * @param type the type
   * @param derive derives another type (an element, a value) with every rule and adapter
   * @return the schema; {@code null} when this adapter doesn't know the type
   * @throws IllegalArgumentException when the adapter knows the type but it can't be a schema
   */
  default @Nullable Map<String, Object> schema(JavaType type, Function<JavaType, Map<String, Object>> derive) {
    return null;
  }

  /**
   * When the type is an optional wrapper (Scala's {@code Option}): the type it wraps. A property of
   * that type isn't required, and may be {@code null}, as a Java {@code Optional} one.
   *
   * @param type the type
   * @return the wrapped type; {@code null} when the type isn't an optional wrapper
   */
  default @Nullable JavaType optionalOf(JavaType type) {
    return null;
  }

  /**
   * A property's default value when the input leaves it out (a Scala case class's default), as a
   * plain JSON value: the property isn't required, and the schema says the default.
   *
   * @param owner the class that has the property
   * @param property the property's name, as Jackson names it
   * @return the default; empty when the property has none
   */
  default Optional<Object> defaultValue(Class<?> owner, String property) {
    return Optional.empty();
  }
}
