// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.log;

import java.util.List;

/**
 * How one record is written, beyond its fields.
 *
 * @param inMessage the fields its message already states. The call line {@code tool acme.lookup ok
 *     12ms} states {@code target}, {@code id}, {@code outcome} and {@code durationMs}: the pretty
 *     format leaves them out, so a terminal line doesn't say everything twice; JSON keeps every
 *     field, for queries, and lists the ones named here (those the record has) as the record's
 *     {@code inMessage}, so a renderer reading JSON leaves them out too.
 */
public record LogOptions(List<String> inMessage) {
  /** No options. */
  public static final LogOptions NONE = new LogOptions(List.of());

  /** Copies the list, unmodifiable. */
  public LogOptions {
    inMessage = List.copyOf(inMessage);
  }

  /**
   * @param keys the fields the message states
   * @return the options
   */
  public static LogOptions inMessage(String... keys) {
    return new LogOptions(List.of(keys));
  }
}
