// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack

/**
 * Kindgi packs in Scala: tools, guardrails, agents and flows, on kindgi-pack (Java), for Scala 2.13
 * and 3.
 *
 * {{{
 * import com.kindgi.pack.scaladsl._
 *
 * object Greet {
 *   final case class Input(name: String, greeting: String = "Hello")
 *   final case class Output(message: String)
 *
 *   val tool: Tool[Input, Output] = Tool[Input, Output]("acme.greet")
 *     .description("Formats a greeting for the named recipient.")
 *     .readOnly
 *     .handler((in, ctx) => Output(s"${in.greeting}, ${in.name}!"))
 * }
 * }}}
 *
 * A file's primitives are vals of an object named like the file. The types are kindgi-pack's own,
 * so everything the Java API offers works from Scala as well.
 */
package object scaladsl {
  type Tool[I, O] = com.kindgi.pack.Tool[I, O]
  type Guardrail[C] = com.kindgi.pack.Guardrail[C]
  type Agent = com.kindgi.pack.Agent
  type Flow = com.kindgi.pack.Flow
  type ToolContext = com.kindgi.pack.ToolContext
  type RunTrace = com.kindgi.pack.RunTrace
  type CheckResult = com.kindgi.pack.CheckResult
  type Cancellation = com.kindgi.pack.Cancellation
}
