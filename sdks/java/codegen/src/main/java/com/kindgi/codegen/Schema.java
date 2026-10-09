// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.codegen;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * One JSON Schema object of the API document, read as the parser left it (maps, lists, strings,
 * numbers, booleans), with the keywords the generator supports. {@link #check} refuses any other
 * keyword, so a schema feature this generator doesn't know fails the build instead of being
 * ignored.
 */
final class Schema {
  /** Every keyword the Kindgi API's schemas use, and nothing else. */
  static final Set<String> KEYWORDS =
      Set.of(
          "$ref", "type", "description", "properties", "required", "additionalProperties",
          "items", "enum", "const", "default", "format", "oneOf", "anyOf", "allOf", "discriminator",
          "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum",
          "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties",
          "propertyNames", "examples", "nullable", "x-error-codes");

  /** The string formats with a Java type, plus those kept as text. */
  static final Set<String> FORMATS = Set.of("uuid", "date-time", "uri", "binary");

  final Map<String, Object> raw;
  /** Where in the document this schema is, for error messages. */
  final String where;

  Schema(Map<String, Object> raw, String where) {
    this.raw = raw;
    this.where = where;
  }

  @SuppressWarnings("unchecked")
  static Schema of(Object value, String where) {
    if (!(value instanceof Map)) {
      throw new GenerationException(where + ": a schema must be an object, not " + value);
    }
    return new Schema((Map<String, Object>) value, where);
  }

  /** Fails on any keyword outside {@link #KEYWORDS}, and on an unknown string format. */
  Schema check() {
    for (String key : raw.keySet()) {
      if (!KEYWORDS.contains(key)) {
        throw new GenerationException(
            where + ": unsupported schema keyword \"" + key + "\" (supported: the keywords in"
                + " Schema.KEYWORDS). Teach the generator this keyword first.");
      }
    }
    String format = string("format");
    if (format != null && !FORMATS.contains(format)) {
      throw new GenerationException(where + ": unsupported format \"" + format + "\"");
    }
    return this;
  }

  boolean has(String key) {
    return raw.containsKey(key);
  }

  String ref() {
    String ref = string("$ref");
    if (ref == null) {
      return null;
    }
    String prefix = "#/components/schemas/";
    if (!ref.startsWith(prefix)) {
      throw new GenerationException(where + ": unsupported $ref " + ref);
    }
    return ref.substring(prefix.length());
  }

  String string(String key) {
    Object v = raw.get(key);
    if (v == null) {
      return null;
    }
    if (!(v instanceof String)) {
      throw new GenerationException(where + ": \"" + key + "\" must be a string");
    }
    return (String) v;
  }

  String description() {
    return string("description");
  }

  /** The `type` as a set: `"string"` → {string}; `["string","null"]` → {string, null}. */
  Set<String> types() {
    Object t = raw.get("type");
    Set<String> out = new LinkedHashSet<>();
    if (t instanceof String) {
      out.add((String) t);
    } else if (t instanceof List) {
      for (Object o : (List<?>) t) {
        out.add((String) o);
      }
    } else if (t != null) {
      throw new GenerationException(where + ": unsupported type " + t);
    }
    return out;
  }

  /** The non-null type, when there is exactly one; {@code null} when there's no type. */
  String type() {
    Set<String> ts = new LinkedHashSet<>(types());
    ts.remove("null");
    if (ts.size() > 1) {
      return "multiple";
    }
    return ts.isEmpty() ? null : ts.iterator().next();
  }

  /** Whether `null` is an allowed value: `type: [X, "null"]` or OpenAPI 3.0's `nullable`. */
  boolean nullableType() {
    return types().contains("null") || Boolean.TRUE.equals(raw.get("nullable"));
  }

  Map<String, Schema> properties() {
    Map<String, Schema> out = new LinkedHashMap<>();
    Object p = raw.get("properties");
    if (p == null) {
      return out;
    }
    if (!(p instanceof Map)) {
      throw new GenerationException(where + ": properties must be an object");
    }
    for (Map.Entry<?, ?> e : ((Map<?, ?>) p).entrySet()) {
      String name = (String) e.getKey();
      out.put(name, Schema.of(e.getValue(), where + ".properties." + name));
    }
    return out;
  }

  Set<String> required() {
    Object r = raw.get("required");
    Set<String> out = new LinkedHashSet<>();
    if (r instanceof Collection) {
      for (Object o : (Collection<?>) r) {
        out.add((String) o);
      }
    }
    return out;
  }

  /** `additionalProperties`: {@code false}, {@code true}, or a schema. Absent reads as {@code null}. */
  Object additionalProperties() {
    Object ap = raw.get("additionalProperties");
    if (ap == null || ap instanceof Boolean) {
      return ap;
    }
    return Schema.of(ap, where + ".additionalProperties");
  }

  Schema items() {
    Object i = raw.get("items");
    return i == null ? null : Schema.of(i, where + ".items");
  }

  List<Schema> variants() {
    String key = raw.containsKey("oneOf") ? "oneOf" : raw.containsKey("anyOf") ? "anyOf" : null;
    if (key == null) {
      return List.of();
    }
    if (raw.containsKey("oneOf") && raw.containsKey("anyOf")) {
      throw new GenerationException(where + ": both oneOf and anyOf");
    }
    return list(key);
  }

  List<Schema> allOf() {
    return raw.containsKey("allOf") ? list("allOf") : List.of();
  }

  private List<Schema> list(String key) {
    Object v = raw.get(key);
    if (!(v instanceof List)) {
      throw new GenerationException(where + ": " + key + " must be a list");
    }
    List<Schema> out = new ArrayList<>();
    int i = 0;
    for (Object o : (List<?>) v) {
      out.add(Schema.of(o, where + "." + key + "[" + i++ + "]"));
    }
    return out;
  }

  /**
   * The `enum` values of a string enum; {@code null} for no enum, or for an enum of booleans or
   * numbers (those keep their plain type: see {@link #scalarEnumType()}).
   */
  List<String> enumValues() {
    Object e = raw.get("enum");
    if (e == null || scalarEnumType() != null) {
      return null;
    }
    List<String> out = new ArrayList<>();
    for (Object o : (List<?>) e) {
      if (!(o instanceof String)) {
        throw new GenerationException(where + ": only string enums are supported, found " + o);
      }
      out.add((String) o);
    }
    return out;
  }

  /** {@code "boolean"} or {@code "number"} for an enum of only those; {@code null} otherwise. */
  String scalarEnumType() {
    Object e = raw.get("enum");
    if (!(e instanceof List) || ((List<?>) e).isEmpty()) {
      return null;
    }
    boolean booleans = ((List<?>) e).stream().allMatch(v -> v instanceof Boolean);
    boolean numbers = ((List<?>) e).stream().allMatch(v -> v instanceof Number);
    return booleans ? "boolean" : numbers ? "number" : null;
  }

  Object constValue() {
    return raw.get("const");
  }

  boolean hasConst() {
    return raw.containsKey("const");
  }

  Integer integer(String key) {
    Object v = raw.get(key);
    if (v == null) {
      return null;
    }
    if (!(v instanceof Number)) {
      throw new GenerationException(where + ": \"" + key + "\" must be a number");
    }
    return ((Number) v).intValue();
  }

  BigDecimal decimal(String key) {
    Object v = raw.get(key);
    if (v == null) {
      return null;
    }
    if (!(v instanceof Number)) {
      throw new GenerationException(where + ": \"" + key + "\" must be a number");
    }
    return new BigDecimal(v.toString());
  }

  boolean flag(String key) {
    return Boolean.TRUE.equals(raw.get(key));
  }

  /** A schema with no type and no structure: any JSON value (`{}`, or only a description). */
  boolean isAny() {
    for (String k : raw.keySet()) {
      if (!k.equals("description") && !k.equals("examples") && !k.equals("default")) {
        return false;
      }
    }
    return true;
  }

  @Override
  public String toString() {
    return where;
  }
}
