// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.models;

import java.math.BigDecimal;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Deque;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * Collects the ways a value breaks the API's constraints, with where each one is. The generated
 * models call it from {@link Model#validate(Checks)}; you call {@link Model#validate()} instead.
 *
 * <p>Every check skips a {@code null} value: whether a property is required is checked when a
 * model is constructed.
 */
public final class Checks {
  private final List<String> violations = new ArrayList<>();
  private final Deque<String> path = new ArrayDeque<>();

  /** An empty set of checks. */
  public Checks() {}

  // ---------------------------------------------------------------------------------------------
  // Construction (static): what a record's constructor enforces.
  // ---------------------------------------------------------------------------------------------

  /**
   * A required property.
   *
   * @param <T> its type
   * @param value the value
   * @param where the property ({@code "Run.id"})
   * @return the value
   * @throws ValidationException when it's {@code null}
   */
  public static <T> T required(@Nullable T value, String where) {
    if (value == null) {
      throw new ValidationException(owner(where), List.of(where + ": is required"));
    }
    return value;
  }

  /**
   * A property with one fixed value: {@code null} becomes it.
   *
   * @param <T> its type
   * @param value the value
   * @param expected the fixed value
   * @param where the property
   * @return the fixed value
   * @throws ValidationException when it's another value
   */
  public static <T> T constant(@Nullable T value, T expected, String where) {
    if (value == null) {
      return expected;
    }
    if (!value.equals(expected)) {
      throw new ValidationException(owner(where), List.of(where + ": must be " + expected + ", not " + value));
    }
    return value;
  }

  /**
   * An optional, nullable property: {@code null} means absent.
   *
   * @param <T> its type
   * @param value the value
   * @return the value, or absent
   */
  public static <T> OptionalNullable<T> triState(@Nullable OptionalNullable<T> value) {
    return value == null ? OptionalNullable.absent() : value;
  }

  /**
   * An unmodifiable copy of a list.
   *
   * @param <T> the item type
   * @param value the list
   * @return the copy, or {@code null}
   */
  public static <T> @Nullable List<T> list(@Nullable List<T> value) {
    return value == null ? null : Collections.unmodifiableList(new ArrayList<>(value));
  }

  /**
   * An unmodifiable copy of a map, in its order.
   *
   * @param <V> the value type
   * @param value the map
   * @return the copy, or {@code null}
   */
  public static <V> @Nullable Map<String, V> map(@Nullable Map<String, V> value) {
    return value == null ? null : Collections.unmodifiableMap(new LinkedHashMap<>(value));
  }

  /**
   * The properties kept beside the known ones: never {@code null}.
   *
   * @param <V> the value type
   * @param value the properties
   * @return an unmodifiable copy, empty for {@code null}
   */
  public static <V> Map<String, V> extras(@Nullable Map<String, V> value) {
    return value == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(value));
  }

  private static String owner(String where) {
    int dot = where.lastIndexOf('.');
    return dot < 0 ? where : where.substring(0, dot);
  }

  // ---------------------------------------------------------------------------------------------
  // Constraints: what validate() checks.
  // ---------------------------------------------------------------------------------------------

  /** @return the problems found so far */
  public List<String> violations() {
    return Collections.unmodifiableList(violations);
  }

  /**
   * Throws when any check failed.
   *
   * @param subject what was checked, for the message
   * @throws ValidationException listing every problem
   */
  public void throwIfAny(String subject) {
    if (!violations.isEmpty()) {
      throw new ValidationException(subject, violations);
    }
  }

  private String at(String name) {
    StringBuilder sb = new StringBuilder();
    for (String part : path) {
      append(sb, part);
    }
    append(sb, name);
    return sb.length() == 0 ? "(value)" : sb.toString();
  }

  private static void append(StringBuilder sb, String part) {
    if (part.isEmpty()) {
      return;
    }
    if (sb.length() > 0 && !part.startsWith("[")) {
      sb.append('.');
    }
    sb.append(part);
  }

  private void fail(String name, String message) {
    violations.add(at(name) + ": " + message);
  }

  /**
   * @param name the property
   * @param value the text
   * @param min the fewest characters (code points)
   */
  public void minLength(String name, @Nullable String value, int min) {
    if (value != null && value.codePointCount(0, value.length()) < min) {
      fail(name, "must be at least " + min + (min == 1 ? " character" : " characters") + " long");
    }
  }

  /**
   * @param name the property
   * @param value the text
   * @param max the most characters (code points)
   */
  public void maxLength(String name, @Nullable String value, int max) {
    if (value != null && value.codePointCount(0, value.length()) > max) {
      fail(name, "must be at most " + max + (max == 1 ? " character" : " characters") + " long");
    }
  }

  /**
   * @param name the property
   * @param value the text
   * @param pattern what it must contain a match of (the schema's {@code pattern})
   */
  public void pattern(String name, @Nullable String value, Pattern pattern) {
    if (value != null && !pattern.matcher(value).find()) {
      fail(name, "must match " + pattern.pattern());
    }
  }

  /**
   * @param name the property
   * @param value the number
   * @param min the smallest allowed value
   */
  public void minimum(String name, @Nullable Number value, String min) {
    if (value != null && decimal(value).compareTo(new BigDecimal(min)) < 0) {
      fail(name, "must be at least " + min);
    }
  }

  /**
   * @param name the property
   * @param value the number
   * @param max the largest allowed value
   */
  public void maximum(String name, @Nullable Number value, String max) {
    if (value != null && decimal(value).compareTo(new BigDecimal(max)) > 0) {
      fail(name, "must be at most " + max);
    }
  }

  /**
   * @param name the property
   * @param value the number
   * @param min the value it must be greater than
   */
  public void exclusiveMinimum(String name, @Nullable Number value, String min) {
    if (value != null && decimal(value).compareTo(new BigDecimal(min)) <= 0) {
      fail(name, "must be greater than " + min);
    }
  }

  private static BigDecimal decimal(Number n) {
    return n instanceof BigDecimal ? (BigDecimal) n : new BigDecimal(n.toString());
  }

  /**
   * @param name the property
   * @param value the list
   * @param min the fewest items
   */
  public void minItems(String name, @Nullable Collection<?> value, int min) {
    if (value != null && value.size() < min) {
      fail(name, "must have at least " + min + (min == 1 ? " item" : " items"));
    }
  }

  /**
   * @param name the property
   * @param value the list
   * @param max the most items
   */
  public void maxItems(String name, @Nullable Collection<?> value, int max) {
    if (value != null && value.size() > max) {
      fail(name, "must have at most " + max + (max == 1 ? " item" : " items"));
    }
  }

  /**
   * @param name the property
   * @param value the list
   */
  public void uniqueItems(String name, @Nullable Collection<?> value) {
    if (value != null && new HashSet<>(value).size() != value.size()) {
      fail(name, "must not repeat an item");
    }
  }

  /**
   * @param name the property
   * @param value the map
   * @param min the fewest entries
   */
  public void minProperties(String name, @Nullable Map<?, ?> value, int min) {
    if (value != null && value.size() < min) {
      fail(name, "must have at least " + min + (min == 1 ? " property" : " properties"));
    }
  }

  /**
   * @param name the property
   * @param value the map
   * @param max the most entries
   */
  public void maxProperties(String name, @Nullable Map<?, ?> value, int max) {
    if (value != null && value.size() > max) {
      fail(name, "must have at most " + max + (max == 1 ? " property" : " properties"));
    }
  }

  /**
   * @param name the property
   * @param value the text
   * @param allowed the values it may take
   */
  public void oneOf(String name, @Nullable String value, List<String> allowed) {
    if (value != null && !allowed.contains(value)) {
      fail(name, "must be one of " + String.join(", ", allowed));
    }
  }

  /**
   * Checks a nested value: a model, or a list or map of them.
   *
   * @param name the property
   * @param value the value
   */
  public void nested(String name, @Nullable Object value) {
    if (value instanceof Model) {
      path.addLast(name);
      try {
        ((Model) value).validate(this);
      } finally {
        path.removeLast();
      }
    } else if (value instanceof List) {
      int i = 0;
      for (Object item : (List<?>) value) {
        nested(name + "[" + i++ + "]", item);
      }
    } else if (value instanceof Map) {
      for (Map.Entry<?, ?> e : ((Map<?, ?>) value).entrySet()) {
        nested(name + "[" + e.getKey() + "]", e.getValue());
      }
    }
  }

  /**
   * Runs {@code check} on each item of a list, where the item is.
   *
   * @param <T> the item type
   * @param name the property
   * @param value the list
   * @param check the item's checks (they use the name {@code ""})
   */
  public <T> void eachItem(String name, @Nullable List<T> value, Consumer<@Nullable T> check) {
    if (value == null) {
      return;
    }
    int i = 0;
    for (T item : value) {
      path.addLast(name + "[" + i + "]");
      try {
        check.accept(item);
      } finally {
        path.removeLast();
        i++;
      }
    }
  }

  /**
   * Runs {@code check} on each key of a map.
   *
   * @param name the property
   * @param value the map
   * @param check the key's checks (they use the name {@code ""})
   */
  public void eachKey(String name, @Nullable Map<String, ?> value, Consumer<String> check) {
    if (value == null) {
      return;
    }
    Set<String> keys = value.keySet();
    for (String key : keys) {
      path.addLast(name + "{" + key + "}");
      try {
        check.accept(key);
      } finally {
        path.removeLast();
      }
    }
  }

  /**
   * Runs {@code check} on each value of a map.
   *
   * @param <V> the value type
   * @param name the property
   * @param value the map
   * @param check the value's checks (they use the name {@code ""})
   */
  public <V> void eachValue(String name, @Nullable Map<String, V> value, Consumer<@Nullable V> check) {
    if (value == null) {
      return;
    }
    for (Map.Entry<String, V> e : value.entrySet()) {
      path.addLast(name + "[" + e.getKey() + "]");
      try {
        check.accept(e.getValue());
      } finally {
        path.removeLast();
      }
    }
  }
}
