// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.tools;

import com.kindgi.pack.Tool;
import jakarta.validation.constraints.Size;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;

public final class Hold {
  public record Input(@Size(min = 1) String release) {}

  public record Held(boolean released) {}

  public static final Tool<Input, Held> TOOL = Tool.define("conformance.hold")
      .description("Prints hold: <release> on stdout, then waits until the file release exists, or until the call is cancelled.")
      .input(Input.class)
      .output(Held.class)
      .handler((input, ctx) -> {
        System.out.println("hold: " + input.release());
        while (!Files.exists(Path.of(input.release()))) {
          if (ctx.cancellation().await(Duration.ofMillis(10))) {
            ctx.cancellation().throwIfCancelled();
          }
        }
        return new Held(true);
      });
}
