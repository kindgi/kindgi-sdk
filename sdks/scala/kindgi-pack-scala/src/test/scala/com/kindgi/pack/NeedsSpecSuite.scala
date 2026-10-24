// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack

import com.kindgi.pack.scaladsl.{Tool => Pack}
import scala.jdk.CollectionConverters._

/**
 * The {@code needsSpec} test-context helpers reach Scala through kindgi-pack's own types
 * ({@code ToolContext} is Scala's own, being an alias): a Scala-built tool's declared env fills and
 * checks the same way, and the builder overrides the same fields, a tool's env included.
 */
class NeedsSpecSuite extends munit.FunSuite {
  private def envTool(env: Map[String, Any]): Tool[Map[String, Any], Any] =
    Pack.json("acme.env").set("needsSpec", Map("env" -> env)).handler((in, _) => in)

  private val noEnv = Map.empty[String, String].asJava
  private val noSecrets = Map.empty[String, AnyRef].asJava

  test("forTest fills a string default and keeps a declared value, from Scala") {
    val tool = envTool(Map("REGION" -> Map("type" -> "string", "default" -> "eu")))
    assertEquals(ToolContext.forTest(tool, noEnv, noSecrets).env().get("REGION"), "eu")
    assertEquals(ToolContext.forTest(tool, Map("REGION" -> "us").asJava, noSecrets).env().get("REGION"), "us")
  }

  test("forTest fails naming a missing env value, from Scala") {
    val tool = envTool(Map("ACCOUNT_ID" -> Map("type" -> "string")))
    val thrown = intercept[IllegalArgumentException](ToolContext.forTest(tool, noEnv, noSecrets))
    assert(thrown.getMessage.contains("needs env value \"ACCOUNT_ID\""))
  }

  test("forTest fails when a value doesn't match its schema, from Scala") {
    val tool = envTool(Map("BASE_URL" -> Map("type" -> "string", "pattern" -> "^https://")))
    val thrown = intercept[IllegalArgumentException](
      ToolContext.forTest(tool, Map("BASE_URL" -> "http://x").asJava, noSecrets))
    assert(thrown.getMessage.contains("doesn't match the schema"))
  }

  test("forTest passes secrets through, from Scala") {
    val tool = envTool(Map("REGION" -> Map("type" -> "string", "default" -> "eu")))
    val ctx = ToolContext.forTest(tool, noEnv, Map[String, AnyRef]("API_TOKEN" -> "t").asJava)
    assertEquals(ctx.secrets().get("API_TOKEN"), "t")
  }

  test("forTest(Builder) overrides tenant, env and secrets, from Scala") {
    val ctx = ToolContext.forTest(new ToolContext.Builder()
      .withTenantId("acme")
      .withEnv(Map("X" -> "1").asJava)
      .withSecrets(Map[String, AnyRef]("KEY" -> "k").asJava))
    assertEquals(ctx.tenantId(), "acme")
    assertEquals(ctx.env().get("X"), "1")
    assertEquals(ctx.secrets().get("KEY"), "k")
  }

  test("forTest(Builder) with a tool decides its env and keeps the rest, from Scala") {
    val tool = envTool(Map("REGION" -> Map("type" -> "string", "default" -> "eu")))
    val ctx = ToolContext.forTest(new ToolContext.Builder()
      .withTool(tool)
      .withProjectId("p-orders")
      .withEnv(Map("UNDECLARED" -> "x").asJava))
    assertEquals(ctx.env().asScala.toMap, Map[String, AnyRef]("REGION" -> "eu"))
    assertEquals(ctx.projectId(), "p-orders")
  }
}
