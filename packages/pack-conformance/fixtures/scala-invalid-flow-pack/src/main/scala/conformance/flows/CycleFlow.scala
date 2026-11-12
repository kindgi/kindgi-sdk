// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.flows

import com.kindgi.pack.scaladsl._

/** Its steps form a cycle: a -> b -> a. */
object CycleFlow {
  val flow: Flow = Flow("conformance.cycle-flow")
    .version("1.0.0")
    .node(Map("id" -> "a", "kind" -> "tool", "ref" -> "conformance.echo"))
    .node(Map("id" -> "b", "kind" -> "tool", "ref" -> "conformance.echo"))
    .edge("e-start", "$start", "a")
    .edge("e-a-b", "a", "b")
    .edge("e-b-a", "b", "a")
    .edge("e-end", "b", "$end")
    .build()
}
