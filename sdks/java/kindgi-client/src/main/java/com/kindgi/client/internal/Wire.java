// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.internal;

import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;

/** How values are written in a URL. */
final class Wire {
  private Wire() {}

  /** A path, query or header value as text: dates in full ISO-8601 (seconds included). */
  static String text(Object value) {
    if (value instanceof OffsetDateTime) {
      return DateTimeFormatter.ISO_OFFSET_DATE_TIME.format((OffsetDateTime) value);
    }
    return String.valueOf(value);
  }

  /** Percent-encodes a path segment: everything but RFC 3986's unreserved characters. */
  static String pathSegment(String value) {
    return encode(value, false);
  }

  /** Percent-encodes a query name or value (a space is {@code %20}). */
  static String query(String value) {
    return encode(value, true);
  }

  private static String encode(String value, boolean query) {
    StringBuilder sb = new StringBuilder();
    for (byte b : value.getBytes(StandardCharsets.UTF_8)) {
      int c = b & 0xff;
      boolean unreserved =
          (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_' || c == '~';
      if (unreserved || (query && c == ':')) {
        sb.append((char) c);
      } else {
        sb.append('%').append(Character.toUpperCase(Character.forDigit(c >> 4, 16))).append(Character.toUpperCase(Character.forDigit(c & 0xf, 16)));
      }
    }
    return sb.toString();
  }
}
