// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.scaladsl

/** What a guardrail's declaration must say, from Scala as from Java. */
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

  test("an llm-judge guardrail needs its judge (judgeCapabilities), from Scala as from Java") {
    val refused = intercept[IllegalStateException](
      Guardrail.json("acme.tone").kind("llm-judge").onViolation("halt")
        .check((_, _) => com.kindgi.pack.CheckResult.pass()))
    assert(refused.getMessage.startsWith("guardrail acme.tone is kind llm-judge with no judgeCapabilities"),
      refused.getMessage)
    val judged = Guardrail.json("acme.tone").kind("llm-judge")
      .judgeCapabilities(Map("needs" -> List(Map("feature" -> "structured-output"))))
      .onViolation("halt").check((_, _) => com.kindgi.pack.CheckResult.pass())
    assertEquals(judged.id(), "acme.tone")
  }
}
