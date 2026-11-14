// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.tools

import com.kindgi.pack.scaladsl._

object Failing {
  val badOutput: Tool[Map[String, Any], Any] = Tool.json("conformance.bad-output")
    .description("Returns output that breaks its own schema.")
    .outputSchema(Map(
      "type" -> "object",
      "properties" -> Map("message" -> Map("type" -> "string")),
      "required" -> List("message")))
    .handler((_, _) => Map("message" -> 42))

  val throws: Tool[Map[String, Any], Any] = Tool.json("conformance.throws")
    .description("Always fails.")
    .handler((_, _) => throw new IllegalStateException("boom"))

  val failsOnPurpose: Tool[Map[String, Any], Any] = Tool.json("conformance.fails-on-purpose")
    .description("Fails the call on purpose: no order Z-9.")
    .handler { (input, _) =>
      val code = if (input.get("bad").contains(true)) "Order Not Found" else "order-not-found"
      throw ToolFailureException(code, "No order Z-9", Map("orderId" -> "Z-9"))
    }
}
