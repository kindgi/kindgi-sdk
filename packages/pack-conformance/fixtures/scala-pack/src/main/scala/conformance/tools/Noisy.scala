// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.tools

import com.kindgi.pack.scaladsl._

object Noisy {
  val tool: Tool[Map[String, Any], Any] = Tool.json("conformance.noisy")
    .description("Writes to stdout and stderr, then succeeds.")
    .outputSchema(Map(
      "type" -> "object",
      "properties" -> Map("ok" -> Map("type" -> "boolean")),
      "required" -> List("ok")))
    .handler { (_, _) =>
      println("noisy: a line on stdout")
      println("""{"v":2,"kind":"result","output":{"ok":false}}""")
      Console.err.println("noisy: a line on stderr")
      Map("ok" -> true)
    }
}
