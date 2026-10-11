// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.tools

import com.kindgi.pack.scaladsl._

object Defaults {
  val tool: Tool[Map[String, Any], Any] = Tool.json("conformance.defaults")
    .description("Returns its input as the handler received it, defaults filled in.")
    .inputSchema(Map(
      "type" -> "object",
      "properties" -> Map(
        "name" -> Map("type" -> "string"),
        "greeting" -> Map("type" -> "string", "default" -> "Hello"),
        "options" -> Map(
          "type" -> "object",
          "properties" -> Map("loud" -> Map("type" -> "boolean", "default" -> false)),
          "default" -> Map())),
      "required" -> List("name")))
    .outputSchema(Map("type" -> "object"))
    .handler((in, _) => in)
}
