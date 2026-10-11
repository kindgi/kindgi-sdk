// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.flows

import com.kindgi.pack.scaladsl._
import conformance.tools.Echo

object EchoFlow {
  val flow: Flow = Flow("conformance.echo-flow")
    .version("1.0.0")
    .toolNode("echo", Echo.tool)
    .edge("e-start", "$start", "echo")
    .edge("e-end", "echo", "$end")
    .build()
}
