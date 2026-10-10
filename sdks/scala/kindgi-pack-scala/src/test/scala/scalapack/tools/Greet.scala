// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package scalapack.tools

import com.kindgi.pack.scaladsl._
import jakarta.validation.constraints.Size

object Greet {
  final case class Input(@Size(min = 1) name: String, title: Option[String], greeting: String = "Hello", tags: Seq[String] = Nil)
  final case class Output(message: String)

  val tool: Tool[Input, Output] = Tool[Input, Output]("acme.greet")
    .description("Formats a greeting for the named recipient.")
    .readOnly
    .handler((in, _) => Output(s"${in.greeting}, ${in.title.fold("")(_ + " ")}${in.name}!"))
}
