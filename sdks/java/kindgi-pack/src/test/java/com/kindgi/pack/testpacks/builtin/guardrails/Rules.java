// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.builtin.guardrails;

import com.kindgi.pack.Guardrail;
import java.util.List;
import java.util.Map;

public final class Rules {
  public static final Guardrail<Map<String, Object>> NO_GUARANTEES = Guardrail.define("acme.no-guarantees")
      .name("No guarantees")
      .onViolation("halt")
      .builtInCheck("forbidden-substring", Map.of("patterns", List.of("guaranteed", "we promise")));

  public static final Guardrail<Map<String, Object>> NO_REFUNDS = Guardrail.define("acme.no-refunds")
      .action(Map.of("on-violation", "retry", "retry", Map.of("maxAttempts", 2)))
      .set("at", "before-tool")
      .builtInCheck("never-call-tool", Map.of("tools", List.of("acme.refund")));

  public static final Guardrail<Map<String, Object>> CITES = Guardrail.define("acme.cites")
      .onViolation("log-only")
      .builtInCheck("must-cite");
}
