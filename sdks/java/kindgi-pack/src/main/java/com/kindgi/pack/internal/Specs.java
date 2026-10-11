// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** The Kindgi specs this library checks against ({@code @kindgi/specs}, bundled at build). */
public final class Specs {
  private static final Map<String, Map<String, Object>> CACHE = new ConcurrentHashMap<>();

  private Specs() {}

  /**
   * @param name the spec ({@code pack-index}, {@code flow})
   * @return its schema
   */
  @SuppressWarnings("unchecked")
  public static Map<String, Object> schema(String name) {
    return CACHE.computeIfAbsent(name, n -> {
      String resource = "/com/kindgi/pack/specs/" + n + ".schema.json";
      try (InputStream in = Specs.class.getResourceAsStream(resource)) {
        if (in == null) {
          throw new IllegalStateException("kindgi-pack is missing " + resource);
        }
        return (Map<String, Object>) Json.parse(in.readAllBytes());
      } catch (IOException e) {
        throw new UncheckedIOException(e);
      }
    });
  }

  /**
   * @param name the spec
   * @return a validator for it
   */
  public static SchemaValidator validator(String name) {
    return new SchemaValidator(schema(name));
  }

  /**
   * @param name the spec
   * @param def one of its {@code $defs} ({@code tool})
   * @return a validator for that definition
   */
  @SuppressWarnings("unchecked")
  public static SchemaValidator validator(String name, String def) {
    Map<String, Object> s = new LinkedHashMap<>();
    s.put("$defs", schema(name).get("$defs"));
    s.put("$ref", "#/$defs/" + def);
    return new SchemaValidator(s);
  }
}
