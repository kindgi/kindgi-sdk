// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.good.tools;

import com.kindgi.pack.Tool;
import java.util.Map;

public final class GreetV2 {
  public static final Tool<Map<String, Object>, Map<String, Object>> TOOL = Tool.define("acme.greet")
      .version("2.0.0")
      .effect("network", "api:greetings")
      .handler((input, ctx) -> Map.of());
}
