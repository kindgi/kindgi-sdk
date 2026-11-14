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

  test("a built-in check is named with its config, and only the runtime runs it") {
    val noGuarantees = Guardrail.json("acme.no-guarantees").onViolation("halt")
      .builtInCheck("forbidden-substring", Map("patterns" -> List("guaranteed", "we promise")))
    assert(noGuarantees.builtIn())
    assertEquals(noGuarantees.checkId(), "forbidden-substring")
    assert(noGuarantees.configSchema() == null)
    val ran = intercept[UnsupportedOperationException](
      noGuarantees.evaluate(Map.empty[String, Any], new com.kindgi.pack.RunTrace(java.util.Map.of())))
    assert(ran.getMessage.contains("names the built-in check \"forbidden-substring\""), ran.getMessage)
    val cites = Guardrail.json("acme.cites").onViolation("log-only").set("at", "final-answer").builtInCheck("must-cite")
    assertEquals(cites.checkId(), "must-cite")
  }

  test("a built-in check refuses a typed config, and what Java's builtInCheck refuses") {
    val typed = intercept[IllegalStateException](
      Guardrail[GuardrailSuite.Words]("acme.g").onViolation("halt").builtInCheck("must-cite"))
    assertEquals(typed.getMessage,
      "guardrail acme.g: a built-in's config is the runtime's to check, so build it from Guardrail.json, with no"
        + " configSchema")
    val unknown = intercept[IllegalArgumentException](
      Guardrail.json("acme.g").onViolation("halt").builtInCheck("acme.checks.mine"))
    assert(unknown.getMessage.contains("\"acme.checks.mine\" isn't a built-in check"), unknown.getMessage)
    val twice = intercept[IllegalStateException](
      Guardrail.json("acme.g").onViolation("halt").set("config", Map("patterns" -> List("x")))
        .builtInCheck("forbidden-substring", Map("patterns" -> List("y"))))
    assert(twice.getMessage.contains("its config is given twice"), twice.getMessage)
    val scoped = intercept[IllegalStateException](
      Guardrail.json("acme.g").onViolation("halt").set("scope", Map("tools" -> List("acme.*")))
        .builtInCheck("must-cite"))
    assert(scoped.getMessage.contains("scope.tools is for \"before-tool\" and \"after-tool\""), scoped.getMessage)
  }
}

object GuardrailSuite {
  final case class Words(words: List[String])
}
