// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.tools

import com.kindgi.pack.scaladsl._
import jakarta.validation.constraints.Min
import java.time.Duration

object Sleep {
  final case class Input(@Min(value = 0) ms: Long)
  final case class Slept(slept: Long)

  val tool: Tool[Input, Slept] = Tool[Input, Slept]("conformance.sleep")
    .description("Waits ms milliseconds, or until the call is cancelled.")
    .handler { (in, ctx) =>
      ctx.cancellation.await(Duration.ofMillis(in.ms))
      ctx.cancellation.throwIfCancelled()
      Slept(in.ms)
    }
}
