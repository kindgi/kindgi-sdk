// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.log;

import java.util.List;

/** A logger from {@code KINDGI_LOG_*} ({@link LoggerBuilder#fromEnv}), or why there's none. */
public sealed interface LoggerFromEnv permits LoggerFromEnv.Ok, LoggerFromEnv.Err {
  /**
   * The logger.
   *
   * @param logger the root logger
   * @param problems settings that are wrong but harmless: log them at boot (an unknown subsystem,
   *     say)
   */
  record Ok(Logger logger, List<String> problems) implements LoggerFromEnv {
    /** Copies the problems, unmodifiable. */
    public Ok {
      problems = List.copyOf(problems);
    }
  }

  /**
   * A setting that can't be honoured: refuse to start, naming it.
   *
   * @param message what's wrong, naming the setting
   */
  record Err(String message) implements LoggerFromEnv {}
}
