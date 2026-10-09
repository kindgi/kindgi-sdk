// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.tools;

import com.kindgi.pack.Tool;
import jakarta.validation.constraints.Min;
import java.time.Duration;

public final class Sleep {
  public record Input(@Min(0) long ms) {}

  public record Slept(long slept) {}

  public static final Tool<Input, Slept> TOOL = Tool.define("conformance.sleep")
      .description("Waits ms milliseconds, or until the call is cancelled.")
      .input(Input.class)
      .output(Slept.class)
      .handler((input, ctx) -> {
        ctx.cancellation().await(Duration.ofMillis(input.ms()));
        ctx.cancellation().throwIfCancelled();
        return new Slept(input.ms());
      });
}
