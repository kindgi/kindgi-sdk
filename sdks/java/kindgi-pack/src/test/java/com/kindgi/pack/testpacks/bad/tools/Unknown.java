// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.bad.tools;

import com.kindgi.pack.Tool;
import java.util.Map;

public final class Unknown {
  public static final Tool<Map<String, Object>, Map<String, Object>> TOOL = Tool.define("acme.unknown")
      .set("colour", "blue")
      .handler((input, ctx) -> Map.of());
}
