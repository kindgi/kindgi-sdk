// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.tools

import com.kindgi.pack.scaladsl._

object Rejects {
  val tool: Tool[Map[String, Any], Any] = Tool.json("conformance.rejects")
    .description("Says the app refused the connection mail, or wraps that refusal.")
    .set("needsSpec", Map(
      "connections" -> Map(
        "mail" -> Map("app" -> "google", "permissions" -> List("gmail.send"), "as" -> "person"))))
    .handler { (in, _) =>
      val refused = new ConnectionRejectedException("mail", "refused")
      if (in.get("wrapped").contains(true)) throw new IllegalStateException("send failed", refused)
      throw refused
    }
}
