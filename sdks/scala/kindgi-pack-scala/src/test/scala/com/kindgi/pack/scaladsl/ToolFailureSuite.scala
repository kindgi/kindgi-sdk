// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.scaladsl

/** A tool's own failure by its Scala name, with its details as a Scala map. */
class ToolFailureSuite extends munit.FunSuite {
  test("keeps its code, its message and its details, as Java's") {
    val failure = intercept[ToolFailureException](
      throw ToolFailureException("order-not-found", "No order Z-9", Map("orderId" -> "Z-9", "lines" -> List(1, 2))))
    assertEquals(failure.code(), "order-not-found")
    assertEquals(failure.getMessage, "No order Z-9")
    assertEquals(failure.details(), java.util.Map.of[String, Object]("orderId", "Z-9", "lines", java.util.List.of(1, 2)))
  }

  test("has no details when it was given none") {
    assertEquals(ToolFailureException("order-not-found", "No order Z-9").details(), null)
  }

  test("refuses a code that isn't kebab case") {
    val refused = intercept[IllegalArgumentException](ToolFailureException("Order Not Found", "No order Z-9"))
    assert(refused.getMessage.contains("kebab case"), refused.getMessage)
  }
}
