// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.guardrails

import com.kindgi.pack.scaladsl._
import jakarta.validation.constraints.Min

object Checks {
  final case class MinLength(@Min(value = 0) minLength: Int = 1)

  val minLength: Guardrail[MinLength] = Guardrail[MinLength]("conformance.min-length")
    .name("Output is long enough")
    .checkId("conformance.checks.min-length")
    .onViolation("halt")
    .severity("error")
    .check { (config, trace) =>
      val output = Option(trace.output).getOrElse("").strip
      if (output.length >= config.minLength) CheckResult.pass else CheckResult.fail("too short")
    }

  val checkThrows: Guardrail[Map[String, Any]] = Guardrail.json("conformance.check-throws")
    .checkId("conformance.checks.throws")
    .onViolation("log-only")
    .check((_, _) => throw new IllegalStateException("check boom"))
}
