// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.models;

/**
 * A value of the Kindgi API: one of the records in this package, or a union of them.
 *
 * <p>A model is checked in two steps. Reading one from the API checks its structure: the types,
 * the required properties, a union's variant. {@link #validate()} also checks the API's
 * constraints (lengths, patterns, ranges); a builder's {@code build()} runs it, and so does the
 * client before it sends a request body. A response isn't held to them, so a newer runtime that
 * relaxes a constraint doesn't break an older client.
 *
 * <p>Before it sends a request body, the client also checks it against the values this client
 * knows ({@link Checks#sending()}): an enum value or a union variant read from a newer runtime
 * can't be sent back. {@code build()} doesn't check that, so an answer that carries one can be
 * copied and changed.
 */
public interface Model {
  /**
   * Adds every way this value breaks the API's constraints to {@code checks}, nested values
   * included. {@link #validate()} is the usual way to call it.
   *
   * @param checks where the problems are collected
   */
  void validate(Checks checks);

  /**
   * Checks this value against the API's constraints, nested values included.
   *
   * @throws ValidationException listing every problem, when there's at least one
   */
  default void validate() {
    Checks checks = new Checks();
    validate(checks);
    checks.throwIfAny(getClass());
  }
}
