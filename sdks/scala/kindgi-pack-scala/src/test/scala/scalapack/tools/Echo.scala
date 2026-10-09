// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package scalapack.tools

import com.kindgi.pack.scaladsl._

object Echo {
  val tool: Tool[Map[String, Any], Any] = Tool.json("acme.echo-json")
    .description("Returns its input as Scala saw it.")
    .inputSchema(Map("type" -> "object", "properties" -> Map("items" -> Map("type" -> "array"))))
    .outputSchema(Map("type" -> "object"))
    .handler((in, _) => Map("got" -> in, "scala" -> in.isInstanceOf[scala.collection.immutable.Map[_, _]]))
}
