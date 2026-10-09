// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.service;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.kindgi.pack.CheckResult;
import com.kindgi.pack.Guardrail;
import jakarta.validation.constraints.Min;
import java.util.Map;

/** Checks for the service's own tests (PackServiceTest). */
public final class Checks {
  public record MinLength(@JsonProperty(defaultValue = "1") @Min(0) int minLength) {}

  /** Passes when the output is at least minLength long; says the length it used. */
  public static final Guardrail<MinLength> MIN = Guardrail.define("acme.min")
      .checkId("acme.checks.min")
      .onViolation("halt")
      .config(MinLength.class)
      .check((config, trace) -> new CheckResult(
          (trace.output() == null ? "" : trace.output()).length() >= config.minLength(), null, null,
          Map.of("minLength", config.minLength())));

  private Checks() {}
}
