// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package scalapack.tools

import com.kindgi.pack.scaladsl._
import scala.concurrent.{ExecutionContext, Future}

object Later {
  final case class Input(n: Int)
  final case class Output(doubled: Int)

  val tool: Tool[Input, Output] = Tool[Input, Output]("acme.later")
    .description("Doubles n, later.")
    .handlerAsync((in, _) => Future(Output(in.n * 2))(ExecutionContext.global))
}
