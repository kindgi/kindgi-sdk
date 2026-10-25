// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.scaladsl

/** A tool's connections and a refusal, by their Scala names. */
class ConnectionsSuite extends munit.FunSuite {
  test("a connection is readable by its name, and printing the context never shows its token") {
    val mail: ToolConnection =
      new ToolConnection("c-1", "google", "Google", "ya29.acme-token", new ConnectionAccount("g-1", "ana@acme.example"), null)
    val ctx: ToolContext = com.kindgi.pack.ToolContext.forTest(java.util.Map.of("mail", mail))
    assertEquals(ctx.connections().get("mail").account().label(), "ana@acme.example")
    assert(!ctx.toString.contains("ya29"), ctx.toString)
  }

  test("a refusal names the connection") {
    val refused = intercept[ConnectionRejectedException](throw new ConnectionRejectedException("mail"))
    assertEquals(refused.connection(), "mail")
  }
}
