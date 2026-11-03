// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.good.tools;

import com.kindgi.pack.Tool;
import java.util.Map;

public final class Refund {
  /** Moves money: a person says yes to each call in a run no person started. */
  public static final Tool<Map<String, Object>, Map<String, Object>> TOOL = Tool.define("acme.refund")
      .effect("writes", "acme:refunds")
      .mutating(true)
      .needsApprovalWhenUnattended(true)
      .handler((input, ctx) -> Map.of());
}
