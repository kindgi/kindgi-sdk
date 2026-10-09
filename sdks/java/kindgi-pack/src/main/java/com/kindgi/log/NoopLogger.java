// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.log;

import java.util.Map;

/** The logger that writes nothing ({@link Logger#noop()}). */
enum NoopLogger implements Logger {
  INSTANCE;

  @Override
  public void log(LogLevel level, String message, Map<String, ?> fields, LogOptions options) {}

  @Override
  public Logger child(Map<String, ?> bindings) {
    return this;
  }

  @Override
  public boolean isLevelEnabled(LogLevel level) {
    return false;
  }
}
