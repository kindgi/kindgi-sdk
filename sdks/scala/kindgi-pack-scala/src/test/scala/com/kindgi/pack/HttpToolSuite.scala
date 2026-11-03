// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack

import com.kindgi.pack.http._
import com.kindgi.pack.scaladsl
import java.{util => ju}

/**
 * The Scala `.http` terminal delegates to the Java builder: the spec it emits as data, that an
 * unknown placeholder is refused, and that calling the tool in this JVM throws (only the Kindgi
 * runtime makes the request). The full refusal matrix lives in the Java `HttpToolTest`; in package
 * `com.kindgi.pack` so it can read the emitted `extra()` the way that test does.
 */
object HttpToolSuite {
  // Top-level (companion) case classes, not inner ones: a `Tool[I, O]` needs a ClassTag for each,
  // and a ClassTag for a class nested in an instance warns that its outer reference can't be checked.
  final case class CaseLookup(court: String, docket: String)
  final case class Found(title: String)
}

class HttpToolSuite extends munit.FunSuite {
  import HttpToolSuite._

  private def specOf(tool: Tool[_, _]): ju.Map[String, AnyRef] =
    tool.extra().get("spec").asInstanceOf[ju.Map[String, AnyRef]]

  private def lookup(): scaladsl.ToolBuilder[CaseLookup, Found] =
    scaladsl.Tool[CaseLookup, Found]("acme.lookup").description("Look up a case.")

  test("an http tool emits its spec as data") {
    val tool = lookup()
      .version("1.0.0")
      .http(
        HttpToolSpec
          .builder()
          .method(HttpMethod.GET)
          .urlTemplate("https://cases.example.com/{court}/{docket}")
          .header("accept", "application/json")
          .authorization(new HttpAuthSpec.Bearer(new ToolSecretRef("local", "ACME_TOKEN")))
          .successStatus(200, 299)
          .build())

    val spec = specOf(tool)
    assertEquals(spec.get("kind"), "http")
    assertEquals(spec.get("method"), "GET")
    assertEquals(spec.get("urlTemplate"), "https://cases.example.com/{court}/{docket}")
    assertEquals(
      spec.get("authorization"),
      ju.Map.of("kind", "bearer", "secretRef", ju.Map.of("envName", "local", "name", "ACME_TOKEN")))
  }

  test("a url placeholder that isn't an input field is refused") {
    val e = intercept[IllegalArgumentException] {
      lookup().http(
        HttpToolSpec.builder().method(HttpMethod.GET).urlTemplate("https://cases.example.com/{region}").build())
    }
    assert(e.getMessage.contains("{region} not a field of the input"), e.getMessage)
  }

  test("calling an http tool in this JVM throws") {
    val tool = lookup().http(
      HttpToolSpec.builder().method(HttpMethod.GET).urlTemplate("https://cases.example.com/{court}/{docket}").build())
    val e = intercept[UnsupportedOperationException] {
      tool.call(CaseLookup("ca", "123"), ToolContext.forTest())
    }
    assert(e.getMessage.contains("the Kindgi runtime makes its request"), e.getMessage)
  }
}
