// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.scaladsl

import com.kindgi.pack.{AsyncCheckHandler, CheckHandler}
import java.util.concurrent.CompletionStage
import scala.concurrent.Future
import scala.jdk.FutureConverters._
import scala.reflect.ClassTag

/** Builds a guardrail. */
object Guardrail {
  /**
   * A guardrail whose config is a case class; its schema comes from the type, defaults included.
   *
   * @param id the guardrail's id
   */
  def apply[C](id: String)(implicit config: ClassTag[C]): GuardrailBuilder[C] =
    new GuardrailBuilder[C](id, Some(config.runtimeClass), None, Vector.empty)

  /**
   * A guardrail whose config is a plain JSON object, with the schema you give (`configSchema`).
   *
   * @param id the guardrail's id
   */
  def json(id: String): GuardrailBuilder[Map[String, Any]] =
    new GuardrailBuilder[Map[String, Any]](id, None, None, Vector.empty)
}

/** A guardrail being built; `check` or `checkAsync` finishes it. */
final class GuardrailBuilder[C] private[scaladsl] (
    id: String,
    configType: Option[Class[_]],
    configSchema: Option[Map[String, Any]],
    steps: Vector[GuardrailBuilder.Step]) {

  private def step(f: GuardrailBuilder.Step): GuardrailBuilder[C] =
    new GuardrailBuilder[C](id, configType, configSchema, steps :+ f)

  /** Its name, for people. */
  def name(name: String): GuardrailBuilder[C] = step(_.name(name))

  /** The check's id, which the runtime calls. */
  def checkId(checkId: String): GuardrailBuilder[C] = step(_.checkId(checkId))

  /** Its kind (`zero-llm`, the default, or another). */
  def kind(kind: String): GuardrailBuilder[C] = step(_.kind(kind))

  /** What a violation does (`halt`, `log-only`, …). */
  def onViolation(action: String): GuardrailBuilder[C] = step(_.onViolation(action))

  /** The whole action, as a plain JSON object. */
  def action(action: Map[String, Any]): GuardrailBuilder[C] = step(_.action(JsonValues.javaMap(action)))

  /** How severe a violation is. */
  def severity(severity: String): GuardrailBuilder[C] = step(_.severity(severity))

  /** Any other field of the guardrail's index entry, as a plain JSON value. */
  def set(field: String, value: Any): GuardrailBuilder[C] = step(_.set(field, JsonValues.toJava(value)))

  /** A json guardrail's config schema. */
  def configSchema(schema: Map[String, Any])(implicit json: C =:= Map[String, Any]): GuardrailBuilder[C] =
    new GuardrailBuilder[C](id, configType, Some(schema), steps)

  /** Finishes the guardrail with its check. */
  def check(f: (C, RunTrace) => CheckResult): Guardrail[C] =
    build(_.check(new CheckHandler[AnyRef] {
      def check(config: AnyRef, trace: RunTrace): CheckResult = f(in(config), trace)
    }))

  /** Finishes the guardrail with a check that answers later; the service awaits the future. */
  def checkAsync(f: (C, RunTrace) => Future[CheckResult]): Guardrail[C] =
    build(_.asyncCheck(new AsyncCheckHandler[AnyRef] {
      def check(config: AnyRef, trace: RunTrace): CompletionStage[CheckResult] = f(in(config), trace).asJava
    }))

  private def in(config: AnyRef): C =
    (if (configType.isEmpty) JsonValues.scalaMap(config) else config).asInstanceOf[C]

  private def build(finish: GuardrailBuilder.JBuilder => com.kindgi.pack.Guardrail[AnyRef]): Guardrail[C] = {
    var b = com.kindgi.pack.Guardrail.define(id).asInstanceOf[GuardrailBuilder.JBuilder]
    configType.foreach(t => b = b.config(t.asInstanceOf[Class[AnyRef]]))
    configSchema.foreach(s => b = b.configSchema(JsonValues.javaMap(s)).asInstanceOf[GuardrailBuilder.JBuilder])
    steps.foreach(s => b = s(b))
    finish(b).asInstanceOf[Guardrail[C]]
  }
}

private[scaladsl] object GuardrailBuilder {
  type JBuilder = com.kindgi.pack.Guardrail.Builder[AnyRef]
  type Step = JBuilder => JBuilder
}

/** A check's verdict. */
object CheckResult {
  /** It passed. */
  def pass: CheckResult = com.kindgi.pack.CheckResult.pass()

  /** It failed, for a reason. */
  def fail(reason: String): CheckResult = com.kindgi.pack.CheckResult.fail(reason)

  /** A verdict with everything it can say; attributes are plain JSON values. */
  def apply(
      passed: Boolean,
      reason: Option[String] = None,
      judgeResponse: Option[String] = None,
      attributes: Map[String, Any] = Map.empty): CheckResult =
    new com.kindgi.pack.CheckResult(
      passed,
      reason.orNull,
      judgeResponse.orNull,
      if (attributes.isEmpty) null else JsonValues.javaMap(attributes))
}
