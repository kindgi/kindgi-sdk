// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.judge.guardrails;

import com.kindgi.pack.CheckResult;
import com.kindgi.pack.Guardrail;
import java.util.List;
import java.util.Map;

public final class Judges {
  public static final Guardrail<Map<String, Object>> TONE = Guardrail.define("acme.tone")
      .kind("llm-judge")
      .checkId("acme.checks.tone")
      .judgeCapabilities(Map.of("needs", List.of(Map.of("feature", "structured-output"))))
      .set("config", Map.of("rubric", "The reply is polite.", "responseFormat", "pass-fail"))
      .onViolation("halt")
      // The runtime judges an llm-judge guardrail with its config; it never calls this check.
      .check((config, trace) -> CheckResult.pass());
}
