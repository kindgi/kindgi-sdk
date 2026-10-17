// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.guardrails;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.kindgi.pack.CheckResult;
import com.kindgi.pack.Guardrail;
import jakarta.validation.constraints.Min;
import java.util.Map;

public final class Checks {
  public record MinLength(@JsonProperty(defaultValue = "1") @Min(0) int minLength) {}

  public static final Guardrail<MinLength> MIN_LENGTH = Guardrail.define("conformance.min-length")
      .name("Output is long enough")
      .checkId("conformance.checks.min-length")
      .onViolation("halt")
      .severity("error")
      .config(MinLength.class)
      .check((config, trace) -> {
        String output = trace.output() == null ? "" : trace.output().strip();
        return output.length() >= config.minLength() ? CheckResult.pass() : CheckResult.fail("too short");
      });

  public static final Guardrail<Map<String, Object>> CHECK_THROWS = Guardrail.define("conformance.check-throws")
      .checkId("conformance.checks.throws")
      .onViolation("log-only")
      .check((config, trace) -> {
        throw new IllegalStateException("check boom");
      });
}
