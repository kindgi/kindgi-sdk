// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.good.guardrails;

import com.kindgi.pack.CheckResult;
import com.kindgi.pack.Guardrail;

public final class Checks {
  public record Config(int minLength) {}

  public static final Guardrail<Config> NOT_EMPTY = Guardrail.define("acme.not-empty")
      .checkId("acme.checks.not-empty")
      .onViolation("retry")
      .config(Config.class)
      .check((config, trace) -> CheckResult.pass());
}
