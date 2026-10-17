// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package scalapack.guardrails

import com.kindgi.pack.scaladsl._
import jakarta.validation.constraints.Min

object Checks {
  final case class MinLength(@Min(value = 0) minLength: Int = 1)

  val minLength: Guardrail[MinLength] = Guardrail[MinLength]("acme.min-length")
    .name("Output is long enough")
    .checkId("acme.checks.min-length")
    .onViolation("halt")
    .check((config, trace) =>
      if (Option(trace.output).getOrElse("").length >= config.minLength) CheckResult.pass else CheckResult.fail("too short"))
}
