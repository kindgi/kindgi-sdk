// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack

import com.kindgi.pack.internal.{Json, SchemaDeriver}
import java.nio.charset.StandardCharsets
import scalapack.tools.Paint

/** Scala 3's simple enums: a string of case names in the schema, read and written by name. */
class ScalaEnumSuite extends munit.FunSuite {
  private def plain(json: String): AnyRef = Json.parse(json.getBytes(StandardCharsets.UTF_8))

  test("an enum's schema lists its cases") {
    assertEquals(SchemaDeriver.schema(classOf[Paint.Input]).asInstanceOf[AnyRef], plain(
      """{"type": "object", "additionalProperties": false,
        | "properties": {
        |   "color": {"type": "string", "enum": ["Red", "Green"]},
        |   "colors": {"type": "array", "items": {"type": "string", "enum": ["Red", "Green"]}, "default": []}},
        | "required": ["color"]}""".stripMargin))
  }

  test("an enum binds and writes by name, and an unknown name says which are known") {
    assertEquals(Json.bind(plain("""{"color": "Green", "colors": ["Red"]}"""), classOf[Paint.Input]),
      Paint.Input(Paint.Color.Green, Seq(Paint.Color.Red)))
    assertEquals(Json.unbind(Paint.Output(Paint.Color.Red)), plain("""{"mixed": "Red"}"""))
    val error = intercept[IllegalArgumentException](Json.bind(plain("""{"color": "Blue"}"""), classOf[Paint.Input]))
    assert(error.getMessage.contains("not one of Red, Green"), error.getMessage)
  }
}
