// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.models;

import java.util.List;

/**
 * An enum of the Kindgi API, open to the values a newer runtime adds: every generated enum class
 * implements it. A value this client doesn't know is kept as it came, so an answer that carries one
 * reads; the client refuses to send one ({@link Checks#sending()}).
 */
public interface OpenEnum {
  /**
   * @return the value as the API spells it
   */
  String asString();

  /**
   * @return whether this client knows the value
   */
  boolean isKnown();

  /**
   * @return the values this client knows, as the API spells them
   */
  List<String> knownValues();
}
