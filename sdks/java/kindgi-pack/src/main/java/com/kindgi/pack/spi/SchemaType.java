// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.spi;

import java.util.List;
import java.util.stream.Collectors;

/**
 * A type whose schema the deriver writes, as an adapter sees it: its class and its type arguments,
 * resolved ({@code Seq[Item]}'s {@code Item}, {@code Map[String, V]}'s {@code V}, generics an
 * enclosing type binds included). No binding library's types.
 *
 * @param rawClass the class
 * @param typeArguments the type arguments, in order; empty for a type with none, or a raw one
 */
public record SchemaType(Class<?> rawClass, List<SchemaType> typeArguments) {
  /** Copies the arguments. */
  public SchemaType {
    typeArguments = List.copyOf(typeArguments);
  }

  /**
   * @param rawClass the class
   * @param typeArguments its type arguments
   * @return the type
   */
  public static SchemaType of(Class<?> rawClass, SchemaType... typeArguments) {
    return new SchemaType(rawClass, List.of(typeArguments));
  }

  /**
   * @param index the argument's position
   * @return that type argument; {@code Object} when the type has none there (a raw type, or Scala's
   *     primitives, which the JVM erases to {@code Object})
   */
  public SchemaType typeArgument(int index) {
    return index < typeArguments.size() ? typeArguments.get(index) : of(Object.class);
  }

  @Override
  public String toString() {
    return typeArguments.isEmpty()
        ? rawClass.getName()
        : rawClass.getName() + typeArguments.stream().map(SchemaType::toString).collect(Collectors.joining(", ", "<", ">"));
  }
}
