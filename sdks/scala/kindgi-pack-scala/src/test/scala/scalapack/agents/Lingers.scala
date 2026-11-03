// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package scalapack.agents

import com.kindgi.pack.scaladsl._

/** Sets `autoCloseAfterInactiveSeconds`, which isn't supported: the indexer refuses it. */
object Lingers {
  val agent: Agent = Agent("acme.lingers")
    .version("1.0.0")
    .name("Lingers")
    .instructions("Wait.")
    .set("conversationPolicy", Map("historyLimit" -> 5, "autoCloseAfterInactiveSeconds" -> 600))
    .build()
}
