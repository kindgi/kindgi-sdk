// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.scaladsl

/** A guardrail's check id can't be a built-in check's, from Scala as from Java. */
class GuardrailSuite extends munit.FunSuite {
  test("a guardrail can't ship its check under a built-in id; under the pack's own it's fine") {
    val refused = intercept[IllegalStateException](
      Guardrail.json("acme.cites").checkId("must-cite").onViolation("halt")
        .check((_, _) => com.kindgi.pack.CheckResult.pass()))
    assert(refused.getMessage.contains("its check id \"must-cite\" is a built-in check's"), refused.getMessage)
    assert(refused.getMessage.contains("Rename your check"), refused.getMessage)
    // Defaulted: the guardrail's own id is its check id.
    val defaulted = intercept[IllegalStateException](
      Guardrail.json("never-call-tool").onViolation("halt").check((_, _) => com.kindgi.pack.CheckResult.pass()))
    assert(defaulted.getMessage.endsWith(", or rename the guardrail."), defaulted.getMessage)
    val own = Guardrail.json("acme.cites").checkId("acme.checks.must-cite").onViolation("halt")
      .check((_, _) => com.kindgi.pack.CheckResult.pass())
    assertEquals(own.checkId(), "acme.checks.must-cite")
  }
}
