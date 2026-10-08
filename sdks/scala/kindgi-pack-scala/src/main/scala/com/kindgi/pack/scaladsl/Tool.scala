// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.scaladsl

import com.kindgi.pack.{AsyncToolHandler, ToolHandler}
import java.util.concurrent.CompletionStage
import scala.concurrent.Future
import scala.jdk.FutureConverters._
import scala.reflect.ClassTag

/** Builds a tool. */
object Tool {
  /**
   * A tool whose input and output are case classes (or other types Jackson binds); their schemas
   * come from the types.
   *
   * @param id the tool's id ({@code acme.greet})
   */
  def apply[I, O](id: String)(implicit input: ClassTag[I], output: ClassTag[O]): ToolBuilder[I, O] =
    new ToolBuilder[I, O](id, Some(input.runtimeClass), Some(output.runtimeClass), None, None, Vector.empty)

  /**
   * A tool whose input is a plain JSON object and whose output any JSON value, with the schemas you
   * give ({@code inputSchema}, {@code outputSchema}): for what a type can't say.
   *
   * @param id the tool's id
   */
  def json(id: String): ToolBuilder[Map[String, Any], Any] =
    new ToolBuilder[Map[String, Any], Any](id, None, None, None, None, Vector.empty)
}

/** A tool being built; {@code handler} or {@code handlerAsync} finishes it. */
final class ToolBuilder[I, O] private[scaladsl] (
    id: String,
    inputType: Option[Class[_]],
    outputType: Option[Class[_]],
    inputSchema: Option[Map[String, Any]],
    outputSchema: Option[Map[String, Any]],
    steps: Vector[ToolBuilder.Step]) {

  private def step(f: ToolBuilder.Step): ToolBuilder[I, O] =
    new ToolBuilder[I, O](id, inputType, outputType, inputSchema, outputSchema, steps :+ f)

  /** What the tool does, for the model choosing it. */
  def description(text: String): ToolBuilder[I, O] = step(_.description(text))

  /** The tool's version, when several sit side by side. */
  def version(version: String): ToolBuilder[I, O] = step(_.version(version))

  /** The tool only reads: a dry run may call it, and approval gates skip it. */
  def readOnly: ToolBuilder[I, O] = step(_.mutating(false))

  /** Whether the tool writes, sends or charges (the default, left unset). */
  def mutating(mutating: Boolean): ToolBuilder[I, O] = step(_.mutating(mutating))

  /** A side effect the tool has, on a resource. */
  def effect(kind: String, resource: String): ToolBuilder[I, O] = step(_.effect(kind, resource))

  /** Any other field of the tool's index entry, as a plain JSON value. */
  def set(field: String, value: Any): ToolBuilder[I, O] = step(_.set(field, JsonValues.toJava(value)))

  /** A json tool's input schema. */
  def inputSchema(schema: Map[String, Any])(implicit json: I =:= Map[String, Any]): ToolBuilder[I, O] =
    new ToolBuilder[I, O](id, inputType, outputType, Some(schema), outputSchema, steps)

  /** A json tool's output schema. */
  def outputSchema(schema: Map[String, Any])(implicit json: O =:= Any): ToolBuilder[I, O] =
    new ToolBuilder[I, O](id, inputType, outputType, inputSchema, Some(schema), steps)

  /** Finishes the tool with its code. */
  def handler(f: (I, ToolContext) => O): Tool[I, O] =
    build(_.handler(new ToolHandler[AnyRef, AnyRef] {
      def handle(input: AnyRef, ctx: ToolContext): AnyRef = f(in(input), ctx).asInstanceOf[AnyRef]
    }))

  /**
   * Finishes the tool with code that answers later. The service awaits the future. Cancelling the
   * call doesn't stop a Scala future: stop its work with {@code ctx.cancellation().onCancel}.
   */
  def handlerAsync(f: (I, ToolContext) => Future[O]): Tool[I, O] =
    build(_.asyncHandler(new AsyncToolHandler[AnyRef, AnyRef] {
      def handle(input: AnyRef, ctx: ToolContext): CompletionStage[AnyRef] =
        f(in(input), ctx).asInstanceOf[Future[AnyRef]].asJava
    }))

  private def in(input: AnyRef): I =
    (if (inputType.isEmpty) JsonValues.scalaMap(input) else input).asInstanceOf[I]

  private def build(finish: ToolBuilder.JBuilder => com.kindgi.pack.Tool[AnyRef, AnyRef]): Tool[I, O] = {
    var b = com.kindgi.pack.Tool.define(id).asInstanceOf[ToolBuilder.JBuilder]
    inputType.foreach(t => b = b.input(t.asInstanceOf[Class[AnyRef]]))
    outputType.foreach(t => b = b.output(t.asInstanceOf[Class[AnyRef]]))
    inputSchema.foreach(s => b = b.input(JsonValues.javaMap(s)).asInstanceOf[ToolBuilder.JBuilder])
    outputSchema.foreach(s => b = b.output(JsonValues.javaMap(s)).asInstanceOf[ToolBuilder.JBuilder])
    steps.foreach(s => b = s(b))
    finish(b).asInstanceOf[Tool[I, O]]
  }
}

private[scaladsl] object ToolBuilder {
  type JBuilder = com.kindgi.pack.Tool.Builder[AnyRef, AnyRef]
  type Step = JBuilder => JBuilder
}
