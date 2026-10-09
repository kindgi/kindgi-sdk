// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.codegen;

/** The API's descriptions as Javadoc text. */
final class Docs {
  private Docs() {}

  /**
   * Text that's safe inside a Javadoc comment: no comment terminator, no HTML or Javadoc tags
   * read from the description, and Markdown code spans as {@code <code>}.
   */
  static String javadoc(String text) {
    if (text == null || text.isBlank()) {
      return "";
    }
    StringBuilder out = new StringBuilder();
    String[] parts = text.strip().split("`", -1);
    // An odd number of backticks leaves the last one unmatched: it stays text.
    boolean balanced = parts.length % 2 == 1;
    for (int i = 0; i < parts.length; i++) {
      String escaped = escape(parts[i]).replace("{", "&#123;").replace("}", "&#125;");
      boolean code = i % 2 == 1 && (balanced || i < parts.length - 1);
      if (code) {
        out.append("<code>").append(escaped).append("</code>");
      } else {
        out.append(i % 2 == 1 ? "`" : "").append(escaped);
      }
    }
    return out.toString().replace("*/", "*&#47;").replace("\n\n", "\n<p>\n");
  }

  /** The first paragraph only, for a method's summary. */
  static String firstParagraph(String text) {
    if (text == null) {
      return "";
    }
    String t = text.strip();
    int cut = t.indexOf("\n\n");
    return cut < 0 ? t : t.substring(0, cut);
  }

  private static String escape(String s) {
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("@", "&#64;").replace("\\", "&#92;");
  }
}
