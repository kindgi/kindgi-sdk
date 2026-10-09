// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.models;

import java.util.List;

/** A value breaks the API's constraints; {@link #violations()} lists every problem. */
public final class ValidationException extends IllegalArgumentException {
  private static final long serialVersionUID = 1L;

  /** @serial the problems, one per entry */
  private final List<String> violations;

  /**
   * @param subject what was checked (a type's name)
   * @param violations every problem found, each starting with where it is
   */
  public ValidationException(String subject, List<String> violations) {
    super(subject + " is invalid: " + String.join("; ", violations));
    this.violations = List.copyOf(violations);
  }

  /**
   * Every problem, each starting with where it is ({@code "name: must be at least 1 character"}).
   *
   * @return the problems
   */
  public List<String> violations() {
    return violations;
  }
}
