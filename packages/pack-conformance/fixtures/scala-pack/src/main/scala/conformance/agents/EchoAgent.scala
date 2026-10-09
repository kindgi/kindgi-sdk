// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.agents

import com.kindgi.pack.scaladsl._
import conformance.guardrails.Checks
import conformance.tools.Echo

object EchoAgent {
  val agent: Agent = Agent("conformance.echo-agent")
    .version("1.0.0")
    .name("Echo agent")
    .instructions("Call conformance.echo with the message.")
    .capability(Map("needs" -> List(Map("feature" -> "tool-use"))))
    .tool(Echo.tool)
    .guardrail(Checks.minLength)
    .build()
}
