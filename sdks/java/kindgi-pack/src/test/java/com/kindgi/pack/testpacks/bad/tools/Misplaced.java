// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.bad.tools;

import com.kindgi.pack.CheckResult;
import com.kindgi.pack.Guardrail;

public final class Misplaced {
  public static final Guardrail<?> CHECK = Guardrail.define("acme.misplaced")
      .onViolation("halt")
      .check((config, trace) -> CheckResult.pass());
}
