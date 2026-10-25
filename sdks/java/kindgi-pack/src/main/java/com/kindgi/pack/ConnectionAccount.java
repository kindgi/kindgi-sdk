// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import java.util.Objects;

/**
 * Whose account at the app a connection is.
 *
 * @param id the account's stable id at the app
 * @param label what people see: an email address, a GitHub account's login
 */
public record ConnectionAccount(String id, String label) {
  /** Both are required. */
  public ConnectionAccount {
    Objects.requireNonNull(id, "id");
    Objects.requireNonNull(label, "label");
  }
}
