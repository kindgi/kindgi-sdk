// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.scaladsl

import com.kindgi.log.LogLevel
import com.kindgi.pack.internal.Json
import java.nio.charset.StandardCharsets
import java.{util => ju}
import scala.jdk.CollectionConverters._

/** `ctx.log` the Scala way: fields as pairs or a Scala map, case classes as objects (redacted by name). */
class LogSuite extends munit.FunSuite {
  final case class Order(id: String, apiKey: String, items: Seq[String], note: Option[String])

  private def capture(): (Logger, ju.List[String]) = {
    val lines = new ju.ArrayList[String]()
    val log = com.kindgi.log.Logger.builder().level(LogLevel.TRACE).subsystem("pack.tool").write(l => { lines.add(l); () }).build()
    (log, lines)
  }

  private def record(line: String): Map[String, Any] =
    Json.parse(line.getBytes(StandardCharsets.UTF_8)).asInstanceOf[ju.Map[String, AnyRef]].asScala.toMap

  test("fields as pairs: a case class is an object, its secret-looking field redacted") {
    val (log, lines) = capture()
    log.info("looked up order", "orderId" -> "o-1", "order" -> Order("o-1", "sk-live", Seq("a"), None), "n" -> BigDecimal(2))
    val got = record(lines.get(0))
    assertEquals(got("message"), "looked up order")
    assertEquals(got("orderId"), "o-1")
    val order = got("order").asInstanceOf[ju.Map[String, AnyRef]]
    assertEquals(order.asScala.keys.toList, List("id", "apiKey", "items", "note"))
    assertEquals(order.get("apiKey"), "[redacted]")
    assertEquals(order.get("items"), ju.List.of("a"))
    assertEquals(order.get("note"), null)
    assertEquals(got("n"), Integer.valueOf(2))
  }

  test("fields as a Scala map, a child's bindings, and the Java calls still there") {
    val (log, lines) = capture()
    log.child("runId" -> "r1").warn("slow", Map("ms" -> 900, "steps" -> List(1, 2)))
    log.error("charge failed", new IllegalStateException("declined"))
    log.debug("plain")
    val warn = record(lines.get(0))
    assertEquals(warn("runId"), "r1")
    assertEquals(warn("level"), "warn")
    assertEquals(Json.compactString(warn("steps")), "[1,2]")
    assertEquals(record(lines.get(1))("err").asInstanceOf[ju.Map[String, AnyRef]].get("name"), "IllegalStateException")
    assertEquals(record(lines.get(2))("message"), "plain")
  }

  test("a test context's logger writes nothing") {
    val ctx = com.kindgi.pack.ToolContext.forTest()
    ctx.log.info("nothing to see", "a" -> 1)
    assert(!ctx.log.isLevelEnabled(LogLevel.ERROR))
  }
}
