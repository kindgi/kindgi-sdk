// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.internal;

import java.util.ArrayList;
import java.util.List;
import org.jspecify.annotations.Nullable;

/** Server-sent events, line by line: an event at each blank line. */
final class SseParser {
  /** One event: its type, its data (the {@code data:} lines joined), its id. */
  record Event(String event, String data, @Nullable String id) {}

  private String event = "message";
  private final List<String> data = new ArrayList<>();
  private @Nullable String id;

  /** Feeds one line (without its terminator); returns an event at a blank line that ends one. */
  @Nullable Event feed(String raw) {
    String line = raw.endsWith("\r") ? raw.substring(0, raw.length() - 1) : raw;
    if (line.isEmpty()) {
      return dispatch();
    }
    if (line.startsWith(":")) {
      return null;
    }
    int colon = line.indexOf(':');
    String field = colon < 0 ? line : line.substring(0, colon);
    String value = colon < 0 ? "" : line.substring(colon + 1);
    if (value.startsWith(" ")) {
      value = value.substring(1);
    }
    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        data.add(value);
        break;
      case "id":
        id = value;
        break;
      default:
        break;
    }
    return null;
  }

  private @Nullable Event dispatch() {
    try {
      return data.isEmpty() ? null : new Event(event, String.join("\n", data), id);
    } finally {
      event = "message";
      data.clear();
      id = null;
    }
  }
}
