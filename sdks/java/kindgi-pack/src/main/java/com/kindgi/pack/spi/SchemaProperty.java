// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.spi;

import java.util.OptionalInt;

/**
 * A property of a type whose schema the deriver writes, as an adapter needs to see it: no binding
 * library's types.
 *
 * @param wireName the property's name in JSON, after any renaming ({@code @JsonProperty}, a naming
 *     module)
 * @param constructorIndex its position among the parameters of the constructor that builds the type
 *     (a Java record's component, a Scala case class's parameter); empty when no constructor takes it
 * @param declaringType the type whose schema is being written, which has the property
 * @param rawType the property's declared class
 */
public record SchemaProperty(String wireName, OptionalInt constructorIndex, Class<?> declaringType, Class<?> rawType) {}
