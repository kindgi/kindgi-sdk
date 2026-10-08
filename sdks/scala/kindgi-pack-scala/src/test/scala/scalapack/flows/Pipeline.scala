// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package scalapack.flows

import com.kindgi.pack.scaladsl._
import scalapack.tools.Greet

object Pipeline {
  val flow: Flow = Flow("acme.pipeline")
    .version("1.0.0")
    .toolNode("greet", Greet.tool)
    .edge("e-start", "$start", "greet")
    .edge("e-end", "greet", "$end")
    .build()
}
