// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.tools

import com.kindgi.pack.scaladsl._
import jakarta.validation.constraints.Size
import java.nio.file.{Files, Path}
import java.time.Duration

object Hold {
  final case class Input(@Size(min = 1) release: String)
  final case class Held(released: Boolean)

  val tool: Tool[Input, Held] = Tool[Input, Held]("conformance.hold")
    .description("Prints hold: <release> on stdout, then waits until the file release exists, or until the call is cancelled.")
    .handler { (in, ctx) =>
      println(s"hold: ${in.release}")
      while (!Files.exists(Path.of(in.release))) {
        if (ctx.cancellation.await(Duration.ofMillis(10))) ctx.cancellation.throwIfCancelled()
      }
      Held(true)
    }
}
