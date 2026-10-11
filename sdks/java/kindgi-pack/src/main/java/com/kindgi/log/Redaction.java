// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.log;

import com.fasterxml.jackson.annotation.JsonIgnore;
import java.lang.reflect.Array;
import java.lang.reflect.RecordComponent;
import java.time.Instant;
import java.time.temporal.TemporalAccessor;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Date;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * Redaction, applied to every record before it's written, at every level.
 *
 * <ol>
 *   <li><b>Keys.</b> A field whose key looks secret has its value replaced with {@code [redacted]},
 *       at any depth: its key, lowercased with {@code -} and {@code _} removed, ends with {@code
 *       authorization}, {@code cookie}, {@code token}, {@code password}, {@code passwd}, {@code
 *       secret}, {@code secrets}, {@code apikey}, {@code privatekey}, {@code passphrase} or {@code
 *       credential(s)} ({@code accessToken}, {@code x-api-key}, {@code secrets}), plus any the
 *       caller adds. {@code tokenCount} and {@code promptTokens} are not secret, and stay.
 *   <li><b>Values.</b> Every string (the message, fields, an error's message and stack) is scrubbed
 *       of known shapes only, so ids are never mangled: a Kindgi token ({@code kgi_bt_…}, {@code
 *       kgi_pt_…}) keeps its prefix and its last four characters; {@code Bearer <anything>} becomes
 *       {@code Bearer [redacted]}; a URL's password ({@code postgres://user:pass@}) becomes {@code
 *       user:***@}.
 * </ol>
 *
 * The first rule is the code rule's net: secret values are never fields to begin with (pass a
 * secret's name, not its value). The same rules as {@code @kindgi/log} and {@code kindgi.log}.
 */
public final class Redaction {
  private Redaction() {}

  /** What a secret-looking key's value becomes. */
  public static final String REDACTED = "[redacted]";

  private static final List<String> SECRET_KEY_ENDINGS = List.of(
      "authorization", "cookie", "token", "password", "passwd", "secret", "secrets", "apikey",
      "privatekey", "passphrase", "credential", "credentials");

  /** A Kindgi token: {@code kgi_} and a two-letter kind, then its body. */
  private static final Pattern KINDGI_TOKEN = Pattern.compile("\\bkgi_([a-z]{2})_([A-Za-z0-9._~+/=-]+)");
  private static final Pattern BEARER = Pattern.compile("\\b(Bearer)\\s+[^\\s\"',;]+", Pattern.CASE_INSENSITIVE);
  private static final Pattern URL_PASSWORD =
      Pattern.compile("\\b([a-z][a-z0-9+.-]*://[^\\s:/@]+):[^\\s@/]+@", Pattern.CASE_INSENSITIVE);

  private static final int MAX_DEPTH = 8;

  private static String normalize(String key) {
    return key.toLowerCase(Locale.ROOT).replace("-", "").replace("_", "");
  }

  /**
   * @param key a field's key
   * @param extra more key endings to treat as secret
   * @return whether the key looks secret (see rule 1)
   */
  public static boolean isSecretKey(String key, List<String> extra) {
    String k = normalize(key);
    for (String end : SECRET_KEY_ENDINGS) {
      if (k.endsWith(end)) {
        return true;
      }
    }
    for (String end : extra) {
      if (k.endsWith(normalize(end))) {
        return true;
      }
    }
    return false;
  }

  /**
   * @param text a string
   * @return the string with known secret shapes masked (see rule 2)
   */
  public static String scrubText(String text) {
    Matcher token = KINDGI_TOKEN.matcher(text);
    String out = token.replaceAll(m -> {
      String body = m.group(2);
      String tail = body.length() >= 16 ? body.substring(body.length() - 4) : "";
      return Matcher.quoteReplacement("kgi_" + m.group(1) + "_…" + tail);
    });
    out = BEARER.matcher(out).replaceAll("$1 [redacted]");
    return URL_PASSWORD.matcher(out).replaceAll("$1:***@");
  }

  /**
   * A value with both rules applied, recursively, as plain JSON values: secret keys redacted,
   * strings scrubbed. Maps, collections and arrays are copied; a record becomes an object of its
   * components (but those marked {@code @JsonIgnore}); any other object becomes its {@code
   * toString()}, so a logged object is never walked further than its own fields. Anything deeper
   * than a few levels, or a cycle (an object inside itself), becomes a marker. An object referenced
   * twice side by side is copied twice.
   *
   * @param value the value
   * @param extra more key endings to treat as secret
   * @return the redacted copy
   */
  public static @Nullable Object redactValue(@Nullable Object value, List<String> extra) {
    return redact(value, extra, 0, Collections.newSetFromMap(new IdentityHashMap<>()));
  }

  private static @Nullable Object redact(@Nullable Object value, List<String> extra, int depth, Set<Object> path) {
    Object scalar = scalar(value);
    if (scalar != NOT_SCALAR) {
      return scalar;
    }
    Object v = value;
    if (v instanceof Optional) {
      return redact(((Optional<?>) v).orElse(null), extra, depth, path);
    }
    if (v instanceof Throwable) {
      return Errors.serialize(v, false);
    }
    if (path.contains(v)) {
      return "[circular]";
    }
    if (depth >= MAX_DEPTH) {
      return "[too deep]";
    }
    // `path` holds the way from the root: a cycle is an object inside itself.
    path.add(v);
    try {
      if (v instanceof Map) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
          String key = String.valueOf(e.getKey());
          out.put(key, isSecretKey(key, extra) ? REDACTED : redact(e.getValue(), extra, depth + 1, path));
        }
        return out;
      }
      if (v instanceof Collection) {
        List<Object> out = new ArrayList<>();
        for (Object item : (Collection<?>) v) {
          out.add(redact(item, extra, depth + 1, path));
        }
        return out;
      }
      if (v.getClass().isArray()) {
        List<Object> out = new ArrayList<>();
        for (int i = 0; i < Array.getLength(v); i++) {
          out.add(redact(Array.get(v, i), extra, depth + 1, path));
        }
        return out;
      }
      if (v.getClass().isRecord()) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (RecordComponent component : v.getClass().getRecordComponents()) {
          if (component.getAccessor().isAnnotationPresent(JsonIgnore.class)) {
            continue;
          }
          String key = component.getName();
          out.put(key, isSecretKey(key, extra) ? REDACTED : redact(read(component, v), extra, depth + 1, path));
        }
        return out;
      }
      return scrubText(text(v));
    } finally {
      path.remove(v);
    }
  }

  private static final Object NOT_SCALAR = new Object();

  /** A value with no parts, as a record carries it; {@link #NOT_SCALAR} for anything else. */
  private static @Nullable Object scalar(@Nullable Object value) {
    if (value == null || value instanceof Boolean) {
      return value;
    }
    if (value instanceof String) {
      return scrubText((String) value);
    }
    if (value instanceof Double || value instanceof Float) {
      double d = ((Number) value).doubleValue();
      // As JSON.stringify writes them: JSON has no NaN or infinity.
      return Double.isNaN(d) || Double.isInfinite(d) ? null : value;
    }
    if (value instanceof Number) {
      return value;
    }
    if (value instanceof CharSequence || value instanceof Character) {
      return scrubText(value.toString());
    }
    if (value instanceof Enum) {
      return scrubText(((Enum<?>) value).name());
    }
    if (value instanceof Date) {
      return RecordLogger.isoTime(((Date) value).toInstant());
    }
    if (value instanceof Instant) {
      return RecordLogger.isoTime((Instant) value);
    }
    if (value instanceof TemporalAccessor) {
      return scrubText(value.toString());
    }
    return NOT_SCALAR;
  }

  private static @Nullable Object read(RecordComponent component, Object record) {
    try {
      component.getAccessor().setAccessible(true);
      return component.getAccessor().invoke(record);
    } catch (ReflectiveOperationException | RuntimeException e) {
      return "[unreadable]";
    }
  }

  /** An object no other rule covers, as its text: never walked, so a logged object costs its toString(). */
  private static String text(Object value) {
    try {
      return String.valueOf(value);
    } catch (RuntimeException | StackOverflowError e) {
      return "[" + value.getClass().getName() + "]";
    }
  }
}
