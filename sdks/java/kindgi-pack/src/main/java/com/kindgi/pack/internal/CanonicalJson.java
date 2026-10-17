// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.MathContext;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;

/**
 * Canonical JSON: the byte form of a pack index. What the TypeScript and Python indexers write
 * for the same value: keys sorted at every level in UTF-16 code-unit order (as JavaScript sorts,
 * and as {@link String#compareTo} compares), two-space indentation, and numbers as {@code
 * JSON.stringify} writes them ({@code 1}, not {@code 1.0}; {@code 1e-7}, not {@code 1.0E-7}).
 */
public final class CanonicalJson {
  private CanonicalJson() {}

  /**
   * @param value a plain value
   * @return its canonical JSON, without a trailing newline
   */
  public static String stable(Object value) {
    StringBuilder out = new StringBuilder();
    write(value, 0, out);
    return out.toString();
  }

  private static void write(Object value, int depth, StringBuilder out) {
    if (value instanceof Map) {
      Map<?, ?> map = (Map<?, ?>) value;
      List<String> keys = keys(map);
      if (keys.isEmpty()) {
        out.append("{}");
        return;
      }
      String inner = "  ".repeat(depth + 1);
      out.append("{\n");
      for (int i = 0; i < keys.size(); i++) {
        if (i > 0) {
          out.append(",\n");
        }
        out.append(inner);
        string(keys.get(i), out);
        out.append(": ");
        write(map.get(keys.get(i)), depth + 1, out);
      }
      out.append('\n').append("  ".repeat(depth)).append('}');
    } else if (value instanceof Collection) {
      Collection<?> items = (Collection<?>) value;
      if (items.isEmpty()) {
        out.append("[]");
        return;
      }
      String inner = "  ".repeat(depth + 1);
      out.append("[\n");
      int i = 0;
      for (Object item : items) {
        if (i++ > 0) {
          out.append(",\n");
        }
        out.append(inner);
        write(item, depth + 1, out);
      }
      out.append('\n').append("  ".repeat(depth)).append(']');
    } else {
      scalar(value, out);
    }
  }

  private static List<String> keys(Map<?, ?> map) {
    List<String> keys = new ArrayList<>();
    for (Object k : map.keySet()) {
      if (!(k instanceof String)) {
        throw new IllegalArgumentException("JSON object keys must be strings, got " + k);
      }
      keys.add((String) k);
    }
    keys.sort(null); // String.compareTo compares UTF-16 code units, as JavaScript's sort does.
    return keys;
  }

  private static void scalar(Object value, StringBuilder out) {
    if (value == null) {
      out.append("null");
    } else if (value instanceof Boolean) {
      out.append(value);
    } else if (value instanceof String) {
      string((String) value, out);
    } else if (value instanceof Number) {
      out.append(number((Number) value));
    } else {
      throw new IllegalArgumentException(value.getClass().getName() + " is not JSON");
    }
  }

  /** A string as {@code JSON.stringify} writes it: only {@code "}, {@code \} and controls escaped. */
  static void string(String s, StringBuilder out) {
    out.append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"':
          out.append("\\\"");
          break;
        case '\\':
          out.append("\\\\");
          break;
        case '\b':
          out.append("\\b");
          break;
        case '\f':
          out.append("\\f");
          break;
        case '\n':
          out.append("\\n");
          break;
        case '\r':
          out.append("\\r");
          break;
        case '\t':
          out.append("\\t");
          break;
        default:
          boolean lone =
              Character.isSurrogate(c)
                  && !(Character.isHighSurrogate(c) && i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1)))
                  && !(Character.isLowSurrogate(c) && i > 0 && Character.isHighSurrogate(s.charAt(i - 1)));
          if (c < 0x20 || lone) {
            out.append(String.format("\\u%04x", (int) c));
          } else {
            out.append(c);
          }
      }
    }
    out.append('"');
  }

  /**
   * A number as ECMAScript's {@code Number.prototype.toString} writes it.
   *
   * @param n the number
   * @return its text
   */
  public static String number(Number n) {
    boolean integral =
        n instanceof Integer || n instanceof Long || n instanceof Short || n instanceof Byte
            || (n instanceof BigInteger && ((BigInteger) n).bitLength() < 63);
    // An integer JavaScript holds exactly (|n| ≤ 2^53) is written as is; a larger one as
    // JavaScript would have read it: the nearest double.
    if (integral && Math.abs(n.longValue()) <= (1L << 53)) {
      return js(n.doubleValue(), n.longValue());
    }
    return js(n.doubleValue(), null);
  }

  private static String js(double d, Long exact) {
    if (Double.isNaN(d) || Double.isInfinite(d)) {
      throw new IllegalArgumentException(d + " is not JSON");
    }
    if (d == 0) {
      return "0";
    }
    if (exact != null && Math.abs(exact) < 1e21 && (double) exact == d) {
      return Long.toString(exact);
    }
    String sign = d < 0 ? "-" : "";
    // The shortest digits that read back as d; value = 0.digits × 10^n.
    BigDecimal shortest = new BigDecimal(shortestDigits(Math.abs(d)));
    String unscaled = shortest.unscaledValue().toString();
    String stripped = unscaled.replaceAll("0+$", "");
    int k = stripped.length();
    int n = unscaled.length() - shortest.scale();
    if (k <= n && n <= 21) {
      return sign + stripped + "0".repeat(n - k);
    }
    if (0 < n && n <= 21) {
      return sign + stripped.substring(0, n) + "." + stripped.substring(n);
    }
    if (-6 < n && n <= 0) {
      return sign + "0." + "0".repeat(-n) + stripped;
    }
    int e = n - 1;
    String mantissa = k == 1 ? stripped : stripped.charAt(0) + "." + stripped.substring(1);
    return sign + mantissa + "e" + (e >= 0 ? "+" : "-") + Math.abs(e);
  }

  /**
   * The fewest significant digits that read back as {@code d} (plain decimal text): what
   * JavaScript picks. JDK 17's {@code Double.toString} sometimes has one digit more.
   */
  private static String shortestDigits(double d) {
    BigDecimal exactValue = new BigDecimal(d);
    for (int p = 1; p <= 17; p++) {
      BigDecimal rounded = exactValue.round(new MathContext(p, RoundingMode.HALF_EVEN));
      if (Double.parseDouble(rounded.toString()) == d) {
        return rounded.stripTrailingZeros().toPlainString();
      }
    }
    return new BigDecimal(Double.toString(d)).toPlainString();
  }
}
