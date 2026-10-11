// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.bad.tools;

import com.kindgi.pack.Tool;
import java.util.Map;

public final class Boom {
  public static final Tool<Map<String, Object>, Map<String, Object>> TOOL = Tool.define("acme.boom")
      .handler((input, ctx) -> Map.of());

  static {
    if (TOOL != null) {
      throw new IllegalStateException("no database");
    }
  }
}
