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
 *     .handler((in, ctx) => Output(s"\${in.greeting}, \${in.name}!"))
 * }
 * }}}
 *
 * A file's primitives are vals of an object named like the file. The types are kindgi-pack's own,
 * so everything the Java API offers works from Scala as well.
 *
 * A tool's `ctx.log` takes a record's fields as pairs or a Scala map:
 * `ctx.log.info("looked up order", "orderId" -> order.id)`.
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
  type Logger = com.kindgi.log.Logger
  type LogLevel = com.kindgi.log.LogLevel

  /**
   * A record's fields the Scala way, as pairs or a Scala map: `log.info("looked up order", "orderId"
   * -> id)`. An error goes under `err`: `log.error("charge failed", "err" -> e)`, or as the Java
   * API's `log.error("charge failed", e)`.
   */
  implicit final class LoggerOps(private val log: com.kindgi.log.Logger) extends AnyVal {
    def error(message: String, fields: (String, Any)*): Unit = write(com.kindgi.log.LogLevel.ERROR, message, fields)
    def error(message: String, fields: scala.collection.Map[String, Any]): Unit =
      write(com.kindgi.log.LogLevel.ERROR, message, fields)
    def warn(message: String, fields: (String, Any)*): Unit = write(com.kindgi.log.LogLevel.WARN, message, fields)
    def warn(message: String, fields: scala.collection.Map[String, Any]): Unit =
      write(com.kindgi.log.LogLevel.WARN, message, fields)
    def info(message: String, fields: (String, Any)*): Unit = write(com.kindgi.log.LogLevel.INFO, message, fields)
    def info(message: String, fields: scala.collection.Map[String, Any]): Unit =
      write(com.kindgi.log.LogLevel.INFO, message, fields)
    def debug(message: String, fields: (String, Any)*): Unit = write(com.kindgi.log.LogLevel.DEBUG, message, fields)
    def debug(message: String, fields: scala.collection.Map[String, Any]): Unit =
      write(com.kindgi.log.LogLevel.DEBUG, message, fields)
    def trace(message: String, fields: (String, Any)*): Unit = write(com.kindgi.log.LogLevel.TRACE, message, fields)
    def trace(message: String, fields: scala.collection.Map[String, Any]): Unit =
      write(com.kindgi.log.LogLevel.TRACE, message, fields)

    /** A child whose records all carry these fields. */
    def child(bindings: (String, Any)*): com.kindgi.log.Logger = log.child(LogValues.fields(bindings))

    private def write(level: com.kindgi.log.LogLevel, message: String, fields: Iterable[(String, Any)]): Unit =
      log.log(level, message, LogValues.fields(fields), com.kindgi.log.LogOptions.NONE)
  }
}
