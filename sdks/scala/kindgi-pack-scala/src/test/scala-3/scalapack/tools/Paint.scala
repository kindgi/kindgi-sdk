// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package scalapack.tools

import com.kindgi.pack.scaladsl._

/** Scala 3 only: a simple enum in a tool's input and output. */
object Paint {
  enum Color {
    case Red, Green
  }

  final case class Input(color: Color, colors: Seq[Color] = Nil)
  final case class Output(mixed: Color)

  val tool: Tool[Input, Output] = Tool[Input, Output]("acme.paint")
    .description("Echoes a color.")
    .handler((in, _) => Output(in.color))
}
