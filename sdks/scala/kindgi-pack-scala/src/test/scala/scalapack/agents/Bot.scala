// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package scalapack.agents

import com.kindgi.pack.scaladsl._
import scalapack.guardrails.Checks
import scalapack.tools.Greet

object Bot {
  val agent: Agent = Agent("acme.bot")
    .version("1.0.0")
    .name("Greeter")
    .instructions("Greet whoever asks.")
    .capability(Map("needs" -> List(Map("feature" -> "tool-use"))))
    .tool(Greet.tool)
    .guardrail(Checks.minLength)
    .build()
}
