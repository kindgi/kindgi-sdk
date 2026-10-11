// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.codegen;

/**
 * The API document has something the generator doesn't support. The generator covers exactly the
 * constructs the Kindgi API uses and refuses anything else, so a new spec feature can't quietly
 * produce a wrong client: support it here first.
 */
public final class GenerationException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  public GenerationException(String message) {
    super(message);
  }
}
