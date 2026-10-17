// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.tools;

import com.kindgi.pack.Tool;
import jakarta.validation.constraints.Size;

public final class Echo {
  public record Input(@Size(min = 1) String message) {}

  public record Output(String message) {}

  public static final Tool<Input, Output> TOOL = Tool.define("conformance.echo")
      .description("Returns its message.")
      .input(Input.class)
      .output(Output.class)
      .handler((input, ctx) -> new Output(input.message()));
}
