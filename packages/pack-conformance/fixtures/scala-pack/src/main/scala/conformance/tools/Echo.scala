// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.tools

import com.kindgi.pack.scaladsl._
import jakarta.validation.constraints.Size

object Echo {
  final case class Input(@Size(min = 1) message: String)
  final case class Output(message: String)

  val tool: Tool[Input, Output] = Tool[Input, Output]("conformance.echo")
    .description("Returns its message.")
    .handler((in, _) => Output(in.message))
}
