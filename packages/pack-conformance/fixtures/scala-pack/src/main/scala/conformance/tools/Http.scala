// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.tools

import com.kindgi.pack.http._
import com.kindgi.pack.scaladsl._

// A declarative HTTP tool: no handler — the Kindgi runtime makes the request from the spec.
object Http {
  final case class Input(path: String)
  final case class Output(url: String)

  val tool: Tool[Input, Output] = Tool[Input, Output]("conformance.http")
    .description("Reads a path from the example API.")
    .http(
      HttpToolSpec.builder()
        .method(HttpMethod.GET)
        .urlTemplate("https://api.example.com/{path}")
        .header("Accept", "application/json")
        .authorization(new HttpAuthSpec.Bearer(new ToolSecretRef("local", "API_TOKEN")))
        .successStatus(200, 299)
        .build())
}
