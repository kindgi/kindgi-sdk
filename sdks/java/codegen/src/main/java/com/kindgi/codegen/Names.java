// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.codegen;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** How the API's names become Java names. */
final class Names {
  private Names() {}

  private static final Set<String> KEYWORDS =
      Set.of(
          "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class",
          "const", "continue", "default", "do", "double", "else", "enum", "extends", "final",
          "finally", "float", "for", "goto", "if", "implements", "import", "instanceof", "int",
          "interface", "long", "native", "new", "package", "private", "protected", "public",
          "return", "short", "static", "strictfp", "super", "switch", "synchronized", "this",
          "throw", "throws", "transient", "try", "void", "volatile", "while", "true", "false",
          "null", "var", "yield", "record", "sealed", "permits", "_");

  /**
   * Member names a record component can't take: the methods every record (or every generated
   * model) already has. A property with one of these names gets a trailing underscore, as a Java
   * keyword does ({@code wait} → {@code wait_()}).
   */
  static final Set<String> RESERVED_MEMBERS =
      Set.of(
          "hashCode", "equals", "toString", "getClass", "notify", "notifyAll", "wait", "clone",
          "finalize", "builder", "toBuilder", "validate");

  private static final Pattern WORD = Pattern.compile("[A-Za-z0-9]+");

  /** The words of a name: split on anything that isn't a letter or digit, and on camel humps. */
  static List<String> words(String name) {
    List<String> out = new ArrayList<>();
    Matcher m = WORD.matcher(name);
    while (m.find()) {
      String chunk = m.group();
      // Split camel humps: "runId" → run, Id; "HTTPRequest" → HTTP, Request; "v1Runs" → v1, Runs.
      int start = 0;
      for (int i = 1; i < chunk.length(); i++) {
        char prev = chunk.charAt(i - 1);
        char cur = chunk.charAt(i);
        boolean hump = Character.isLowerCase(prev) && Character.isUpperCase(cur);
        boolean acronymEnd =
            Character.isUpperCase(prev)
                && Character.isUpperCase(cur)
                && i + 1 < chunk.length()
                && Character.isLowerCase(chunk.charAt(i + 1));
        boolean digitToUpper = Character.isDigit(prev) && Character.isUpperCase(cur);
        if (hump || acronymEnd || digitToUpper) {
          out.add(chunk.substring(start, i));
          start = i;
        }
      }
      out.add(chunk.substring(start));
    }
    return out;
  }

  /** `run.finished` → `RunFinished`; `adapter_config` → `AdapterConfig`; `StartRunBody` stays. */
  static String pascal(String name) {
    StringBuilder sb = new StringBuilder();
    for (String w : words(name)) {
      sb.append(Character.toUpperCase(w.charAt(0))).append(w.substring(1));
    }
    String out = sb.toString();
    if (out.isEmpty()) {
      throw new GenerationException("can't make a Java type name from \"" + name + "\"");
    }
    return Character.isDigit(out.charAt(0)) ? "_" + out : out;
  }

  /** A Java member name: `adapter_config` → `adapterConfig`; `default` → `default_`. */
  static String camel(String name) {
    String p = pascal(name);
    String out = p.startsWith("_") ? p : Character.toLowerCase(p.charAt(0)) + p.substring(1);
    // Keep an all-caps leading acronym readable: "URL" → "url", "IDs" → "iDs" is avoided.
    List<String> ws = words(name);
    if (!ws.isEmpty() && ws.get(0).length() > 1 && ws.get(0).equals(ws.get(0).toUpperCase(Locale.ROOT))
        && !Character.isDigit(ws.get(0).charAt(0))) {
      String first = ws.get(0);
      out = first.toLowerCase(Locale.ROOT) + out.substring(first.length());
    }
    return KEYWORDS.contains(out) ? out + "_" : out;
  }

  /** A record component or parameter name: {@link #camel}, kept clear of reserved members. */
  static String member(String name) {
    String out = camel(name);
    return RESERVED_MEMBERS.contains(out) ? out + "_" : out;
  }

  /** An enum constant: `run.finished` → `RUN_FINISHED`; `auth-missing` → `AUTH_MISSING`. */
  static String constant(String value) {
    List<String> ws = words(value);
    if (ws.isEmpty()) {
      return "EMPTY";
    }
    String out = String.join("_", ws).toUpperCase(Locale.ROOT);
    return Character.isDigit(out.charAt(0)) ? "_" + out : out;
  }

  static boolean isKeyword(String name) {
    return KEYWORDS.contains(name);
  }
}
