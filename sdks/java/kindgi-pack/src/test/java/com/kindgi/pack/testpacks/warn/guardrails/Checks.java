// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.warn.guardrails;

import com.kindgi.pack.CheckResult;
import com.kindgi.pack.Guardrail;
import java.util.Map;

/** Guardrails whose check ids do and don't start with the pack's id ({@code acme.}). */
public final class Checks {
  /** No {@code checkId}: the check's id is the guardrail's, without the prefix. */
  public static final Guardrail<Map<String, Object>> CITES = Guardrail.define("cites")
      .onViolation("halt")
      .check((config, trace) -> CheckResult.pass());

  /** A prefixed guardrail whose check id isn't. */
  public static final Guardrail<Map<String, Object>> GROUNDED = Guardrail.define("acme.grounded")
      .checkId("checks.grounded")
      .onViolation("halt")
      .check((config, trace) -> CheckResult.pass());

  /** A prefix that isn't the whole pack id. */
  public static final Guardrail<Map<String, Object>> LOOKALIKE = Guardrail.define("acmeplus.cites")
      .onViolation("halt")
      .check((config, trace) -> CheckResult.pass());

  /** Under the pack's id: no warning. */
  public static final Guardrail<Map<String, Object>> FINE = Guardrail.define("acme.fine")
      .checkId("acme.checks.fine")
      .onViolation("halt")
      .check((config, trace) -> CheckResult.pass());
}
