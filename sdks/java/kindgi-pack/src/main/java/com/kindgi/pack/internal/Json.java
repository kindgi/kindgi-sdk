// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JavaType;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jdk8.Jdk8Module;
import com.fasterxml.jackson.databind.util.TokenBuffer;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import java.io.IOException;
import java.lang.reflect.Type;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * JSON as the pack service reads and writes it, with the app's Jackson 2: a JSON value is a
 * {@code Map} (in key order), a {@code List}, a {@code String}, a {@code Number}, a {@code Boolean}
 * or {@code null}; a tool's input and output are bound to its types through their Jackson
 * annotations.
 *
 * <p>Two mappers. The wire's ({@link #mapper()}) reads and writes the protocol's messages and the
 * index, and nothing an app installs changes it. The binding one ({@link #binding()}) also has
 * every Jackson module the app's classpath declares ({@code findAndRegisterModules()}: Scala's,
 * Kotlin's, Guava's, an app's own): it binds tool inputs, writes tool outputs and reads types for
 * their schemas, so a tool's types mean what they mean everywhere else in the app.
 */
public final class Json {
  private Json() {}

  private static final ObjectMapper MAPPER =
      new ObjectMapper()
          .registerModule(new Jdk8Module())
          .registerModule(new JavaTimeModule())
          .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
          .disable(DeserializationFeature.ADJUST_DATES_TO_CONTEXT_TIME_ZONE)
          // The schema already decided: a property the type has no field for is ignored.
          .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
          .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
          .setSerializationInclusion(JsonInclude.Include.NON_NULL);

  private static final ObjectMapper BINDING = MAPPER.copy().findAndRegisterModules();

  /** @return the wire's mapper (shared): the protocol and the index */
  public static ObjectMapper mapper() {
    return MAPPER;
  }

  /** @return the binding mapper (shared): tool inputs and outputs, with the app's Jackson modules */
  public static ObjectMapper binding() {
    return BINDING;
  }

  /**
   * Parses JSON text into a plain value.
   *
   * @param bytes UTF-8 JSON
   * @return the value
   * @throws IOException when it isn't one JSON value
   */
  public static Object parse(byte[] bytes) throws IOException {
    try (JsonParser parser = MAPPER.getFactory().createParser(bytes)) {
      Object value = MAPPER.readValue(parser, Object.class);
      if (parser.nextToken() != null) {
        throw new IOException("more than one JSON value");
      }
      return value;
    }
  }

  /**
   * @param value a plain value
   * @return its compact JSON, UTF-8
   */
  public static byte[] compact(Object value) {
    try {
      return MAPPER.writeValueAsBytes(value);
    } catch (JsonProcessingException e) {
      throw new IllegalArgumentException(e.getOriginalMessage(), e);
    }
  }

  /**
   * @param value a plain value
   * @return its compact JSON
   */
  public static String compactString(Object value) {
    return new String(compact(value), StandardCharsets.UTF_8);
  }

  /**
   * A plain value as a type (a tool's input record), through the type's Jackson annotations.
   *
   * @param value the plain value
   * @param type the type
   * @return the typed value
   */
  public static Object bind(Object value, Type type) {
    JavaType javaType = BINDING.getTypeFactory().constructType(type);
    return BINDING.convertValue(value, javaType);
  }

  /**
   * A wire value built from typed parts (an index entry) as a plain value: the app's modules don't
   * apply.
   *
   * @param value the typed value
   * @return the plain value
   */
  public static Object plain(Object value) {
    return MAPPER.convertValue(value, Object.class);
  }

  /**
   * A tool's typed value (its output, a check's attributes, a default) as a plain value: the inverse
   * of {@link #bind}. Written by the binding mapper, so the app's serializers apply, and read back by
   * the wire's, so the result is plain whatever the app's modules do to untyped values (Scala's
   * module reads them as Scala collections).
   *
   * @param value the typed value
   * @return the plain value
   * @throws IllegalArgumentException when the value can't be written as JSON
   */
  public static @Nullable Object unbind(@Nullable Object value) {
    try (TokenBuffer buffer = new TokenBuffer(BINDING, false)) {
      BINDING.writeValue(buffer, value);
      try (JsonParser parser = buffer.asParser(MAPPER)) {
        return MAPPER.readValue(parser, Object.class);
      }
    } catch (IOException e) {
      throw new IllegalArgumentException(e.getMessage(), e);
    }
  }

  /**
   * @param value a plain JSON value
   * @throws IllegalArgumentException when it holds a number JSON can't write (NaN, an infinity)
   */
  @SuppressWarnings("unchecked")
  public static void requireFinite(@Nullable Object value) {
    if (value instanceof Double || value instanceof Float) {
      double d = ((Number) value).doubleValue();
      if (Double.isNaN(d) || Double.isInfinite(d)) {
        throw new IllegalArgumentException(d + " is not a JSON number");
      }
    } else if (value instanceof Map) {
      for (Object v : ((Map<String, Object>) value).values()) {
        requireFinite(v);
      }
    } else if (value instanceof List) {
      for (Object v : (List<Object>) value) {
        requireFinite(v);
      }
    }
  }
}
