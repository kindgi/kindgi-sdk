// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.log;

import java.util.Locale;
import org.jspecify.annotations.Nullable;

/** How records are written: one JSON object per line, or a line for a person at a terminal. */
public enum LogFormat {
  /** One record per line, the schema every Kindgi service writes. */
  JSON,
  /** {@code HH:MM:SS.mmm LEVEL [subsystem] message key=value …}, an error's frames on the lines after. */
  PRETTY;

  /**
   * {@code KINDGI_LOG_FORMAT}'s value as a format: {@code json} or {@code pretty} as given; {@code
   * auto} (the default) is pretty on a terminal or in development mode ({@code KINDGI_DEV}), and
   * JSON otherwise.
   *
   * @param raw the setting's value; {@code null} or blank is {@code auto}
   * @param isTTY whether the lines go to a terminal
   * @param dev whether development mode is on
   * @return the format, or {@code null} for any other value
   */
  public static @Nullable LogFormat resolve(@Nullable String raw, boolean isTTY, boolean dev) {
    String value = raw == null ? "" : raw.strip().toLowerCase(Locale.ROOT);
    if (value.isEmpty() || value.equals("auto")) {
      return isTTY || dev ? PRETTY : JSON;
    }
    if (value.equals("json")) {
      return JSON;
    }
    if (value.equals("pretty")) {
      return PRETTY;
    }
    return null;
  }
}
