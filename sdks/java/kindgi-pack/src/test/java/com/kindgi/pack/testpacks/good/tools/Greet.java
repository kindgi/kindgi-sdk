// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.good.tools;

import com.kindgi.pack.Tool;
import com.kindgi.pack.testpacks.shared.Shared;

public final class Greet {
  public record Input(String name) {}

  public record Output(String message) {}

  public static final Tool<Input, Output> TOOL = Tool.define("acme.greet")
      .description("Greets.")
      .input(Input.class)
      .output(Output.class)
      .mutating(false)
      .handler((input, ctx) -> new Output("Hello, " + input.name()));

  /** Defined in another class: not this file's to index. */
  public static final Tool<?, ?> REEXPORTED = Shared.TOOL;
}
