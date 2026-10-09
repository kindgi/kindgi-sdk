// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A value with its schema's {@code default}s filled in, as Ajv's {@code useDefaults} fills them
 * (the TypeScript pack service's input validation, and Python's {@code apply_defaults}): a property
 * missing from an object gets its {@code properties} entry's default (a copy), then nested objects
 * and array items are filled the same way. {@code allOf} branches and local {@code $ref}s count;
 * {@code anyOf}, {@code oneOf} and {@code not} don't. The value passed in isn't modified.
 */
public final class Defaults {
  private Defaults() {}

  /**
   * @param schema the schema
   * @param value a plain JSON value
   * @return a copy with the defaults filled in
   */
  public static Object apply(Map<String, Object> schema, Object value) {
    return fill(schema, schema, copy(value));
  }

  @SuppressWarnings("unchecked")
  private static Object fill(Map<String, Object> root, Object node, Object value) {
    if (!(node instanceof Map)) {
      return value;
    }
    Map<String, Object> s = resolve(root, (Map<String, Object>) node);
    Object allOf = s.get("allOf");
    if (allOf instanceof List) {
      for (Object branch : (List<Object>) allOf) {
        value = fill(root, branch, value);
      }
    }
    if (value instanceof Map) {
      Map<String, Object> obj = new LinkedHashMap<>((Map<String, Object>) value);
      Object properties = s.get("properties");
      if (properties instanceof Map) {
        for (Map.Entry<String, Object> p : ((Map<String, Object>) properties).entrySet()) {
          if (!(p.getValue() instanceof Map)) {
            continue;
          }
          Map<String, Object> prop = resolve(root, (Map<String, Object>) p.getValue());
          if (!obj.containsKey(p.getKey()) && prop.containsKey("default")) {
            obj.put(p.getKey(), copy(prop.get("default")));
          }
          if (obj.containsKey(p.getKey())) {
            obj.put(p.getKey(), fill(root, prop, obj.get(p.getKey())));
          }
        }
      }
      return obj;
    }
    if (value instanceof List) {
      List<Object> items = new ArrayList<>((List<Object>) value);
      Object itemSchema = s.get("items");
      if (itemSchema instanceof Map) {
        for (int i = 0; i < items.size(); i++) {
          items.set(i, fill(root, itemSchema, items.get(i)));
        }
      }
      return items;
    }
    return value;
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> resolve(Map<String, Object> root, Map<String, Object> node) {
    Object ref = node.get("$ref");
    if (!(ref instanceof String) || !((String) ref).startsWith("#/")) {
      return node;
    }
    Object target = root;
    for (String part : ((String) ref).substring(2).split("/", -1)) {
      String key = part.replace("~1", "/").replace("~0", "~");
      target = target instanceof Map ? ((Map<String, Object>) target).get(key) : null;
    }
    return target instanceof Map ? (Map<String, Object>) target : Map.of();
  }

  @SuppressWarnings("unchecked")
  static Object copy(Object value) {
    if (value instanceof Map) {
      Map<String, Object> out = new LinkedHashMap<>();
      ((Map<String, Object>) value).forEach((k, v) -> out.put(k, copy(v)));
      return out;
    }
    if (value instanceof List) {
      List<Object> out = new ArrayList<>();
      for (Object v : (List<Object>) value) {
        out.add(copy(v));
      }
      return out;
    }
    return value;
  }
}
