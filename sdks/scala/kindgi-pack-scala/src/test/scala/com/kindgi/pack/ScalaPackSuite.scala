// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack

import com.kindgi.pack.internal.Json
import java.nio.charset.StandardCharsets
import java.nio.file.{Files, Path}
import java.{util => ju}
import scala.jdk.CollectionConverters._

/**
 * The Scala test pack (src/test/scala/scalapack) through kindgi-pack's own indexer, as `kindgi dev`
 * and an image index it. In this package to reach the indexer, which is package-private.
 */
class ScalaPackSuite extends munit.FunSuite {
  private val files = Seq(
    "tools/Greet", "tools/Later", "tools/Echo", "tools/Lazy", "tools/Model",
    "guardrails/Checks", "agents/Bot", "flows/Pipeline")

  private def indexPack(): (ju.Map[String, AnyRef], ju.Map[String, AnyRef]) = {
    val dir = Files.createTempDirectory("kindgi-scala-pack")
    Files.writeString(dir.resolve("kindgi.config.json"),
      """{"language": "scala", "pack": {"id": "acme", "version": "1.0.0"}}""")
    files.foreach { f =>
      val source = dir.resolve(s"src/main/scala/scalapack/$f.scala")
      Files.createDirectories(source.getParent)
      Files.writeString(source, "// compiled from src/test/scala/scalapack\n")
    }
    val outcome = Indexer.run(dir, null, dir.resolve("index.json"), "20261008.1", "2026-10-08T00:00:00.000Z",
      getClass.getClassLoader)
    assertEquals(outcome.get("kind"), "ok", Json.compactString(outcome))
    val report = outcome.get("value").asInstanceOf[ju.Map[String, AnyRef]]
    val text = Files.readString(dir.resolve("index.json"), StandardCharsets.UTF_8)
    (report, Json.parse(text.getBytes(StandardCharsets.UTF_8)).asInstanceOf[ju.Map[String, AnyRef]])
  }

  private def list(value: AnyRef): Seq[ju.Map[String, AnyRef]] =
    value.asInstanceOf[ju.List[ju.Map[String, AnyRef]]].asScala.toSeq

  private def plain(json: String): AnyRef = Json.parse(json.getBytes(StandardCharsets.UTF_8))

  test("a Scala pack indexes its objects' vals; a def is an error that says so; a model is a helper") {
    val (report, index) = indexPack()
    val errors = list(report.get("fileErrors")).map(e => s"${e.get("code")}: ${e.get("message")}")
    assertEquals(errors, Seq(
      "no-primitives: File src/main/scala/scalapack/tools/Lazy.scala: object Lazy defines tool as a def or a lazy val," +
        " which the indexer can't read without running it; make it a val"))
    assertEquals(list(index.get("tools")).map(_.get("id")), Seq("acme.echo-json", "acme.greet", "acme.later"))
    assertEquals(list(index.get("guardrails")).map(_.get("id")), Seq("acme.min-length"))
    assertEquals(list(index.get("agents")).map(_.get("id")), Seq("acme.bot"))
    assertEquals(list(index.get("flows")).map(_.get("id")), Seq("acme.pipeline"))
  }

  test("a case class's schema: Option not required, defaults said, constraints on parameters") {
    val (_, index) = indexPack()
    val greet = list(index.get("tools")).find(_.get("id") == "acme.greet").get
    assertEquals(greet.get("modulePath"), "src/main/scala/scalapack/tools/Greet.scala")
    assertEquals(greet.get("mutating"), java.lang.Boolean.FALSE)
    assertEquals(greet.get("input"), plain(
      """{"type": "object", "additionalProperties": false,
        | "properties": {
        |   "name": {"type": "string", "minLength": 1},
        |   "title": {"type": ["string", "null"]},
        |   "greeting": {"type": "string", "default": "Hello"},
        |   "tags": {"type": "array", "items": {"type": "string"}, "default": []}},
        | "required": ["name"]}""".stripMargin))
    val guardrail = list(index.get("guardrails")).head
    assertEquals(guardrail.get("configSchema"), plain(
      """{"type": "object", "additionalProperties": false,
        | "properties": {"minLength": {"type": "integer", "minimum": 0, "default": 1}}}""".stripMargin))
  }

  test("handlers run with Scala's types: case classes, a future, a json tool's Scala map") {
    val ctx = ToolContext.forTest()
    assertEquals(scalapack.tools.Greet.tool.call(scalapack.tools.Greet.Input("Ada", Some("Dr")), ctx),
      scalapack.tools.Greet.Output("Hello, Dr Ada!"))
    assertEquals(scalapack.tools.Later.tool.call(scalapack.tools.Later.Input(21), ctx), scalapack.tools.Later.Output(42))
    val out = scalapack.tools.Echo.tool.call(Map("items" -> Vector(1, 2)), ctx)
    assertEquals(out, Map("got" -> Map("items" -> Vector(1, 2)), "scala" -> true))
  }

  test("the binding mapper has Scala's Jackson module: inputs bind, outputs write") {
    val bound = Json.bind(plain("""{"name": "Ada", "title": null, "greeting": "Hi", "tags": ["a"]}"""),
      classOf[scalapack.tools.Greet.Input])
    assertEquals(bound, scalapack.tools.Greet.Input("Ada", None, "Hi", Seq("a")))
    assertEquals(Json.unbind(scalapack.tools.Greet.Input("Ada", Some("Dr"))),
      plain("""{"name": "Ada", "title": "Dr", "greeting": "Hello", "tags": []}"""))
  }
}
