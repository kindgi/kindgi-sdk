// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.log;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.LinkedHashMap;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * An error, as a record carries it under {@code err}: {@code name} (the class's simple name), {@code
 * message}, {@code code} when the error has one, {@code stack} at {@code error} or when the logger
 * is at {@code debug} or below, and {@code cause} (three deep at most). Strings are scrubbed.
 */
final class Errors {
  private Errors() {}

  private static final int MAX_CAUSES = 3;

  /**
   * @param err the error; anything else becomes its text
   * @param withStack whether to carry the stack
   * @return the serialized error
   */
  static Object serialize(@Nullable Object err, boolean withStack) {
    return serialize(err, withStack, 0);
  }

  private static Object serialize(@Nullable Object err, boolean withStack, int depth) {
    if (!(err instanceof Throwable)) {
      return Redaction.scrubText(String.valueOf(err));
    }
    Throwable t = (Throwable) err;
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("name", name(t));
    out.put("message", Redaction.scrubText(t.getMessage() == null ? "" : t.getMessage()));
    String code = code(t);
    if (code != null) {
      out.put("code", code);
    }
    if (withStack) {
      out.put("stack", Redaction.scrubText(stack(t)));
    }
    Throwable cause = t.getCause();
    if (cause != null && cause != t && depth < MAX_CAUSES) {
      out.put("cause", serialize(cause, withStack, depth + 1));
    }
    return out;
  }

  private static String name(Throwable t) {
    String simple = t.getClass().getSimpleName();
    return simple.isEmpty() ? t.getClass().getName() : simple;
  }

  /** The error's own frames, as JavaScript writes a stack: its first line, then {@code at} lines. */
  private static String stack(Throwable t) {
    StringBuilder out = new StringBuilder(t.toString());
    for (StackTraceElement frame : t.getStackTrace()) {
      out.append("\n    at ").append(frame);
    }
    return out.toString();
  }

  /**
   * An error's code, when it has one: a public {@code code()} or {@code getCode()} that returns a
   * string, a number or an enum (as a JavaScript error's {@code code}).
   */
  private static @Nullable String code(Throwable t) {
    for (String name : new String[] {"code", "getCode"}) {
      try {
        Method m = t.getClass().getMethod(name);
        if (!Modifier.isPublic(m.getDeclaringClass().getModifiers())) {
          m.setAccessible(true);
        }
        Object value = m.invoke(t);
        if (value instanceof String || value instanceof Number || value instanceof Enum) {
          return Redaction.scrubText(value instanceof Enum ? ((Enum<?>) value).name() : value.toString());
        }
      } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
        // No code, or one that can't be read: the record goes without it.
      }
    }
    return null;
  }
}
