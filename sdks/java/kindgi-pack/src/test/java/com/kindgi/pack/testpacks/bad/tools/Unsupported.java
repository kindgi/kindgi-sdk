// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.bad.tools;

import com.kindgi.pack.Tool;
import java.util.Map;

public final class Unsupported {
  public static final Tool<Map<String, Object>, Map<String, Object>> TOOL = Tool.define("acme.unsupported")
      .input(Map.of("type", "object", "if", Map.of("required", java.util.List.of("a"))))
      .handler((input, ctx) -> Map.of());
}
