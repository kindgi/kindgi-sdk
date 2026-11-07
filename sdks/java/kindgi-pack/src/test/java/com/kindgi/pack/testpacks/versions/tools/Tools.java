// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.versions.tools;

import com.kindgi.pack.Tool;
import java.util.Map;

public final class Tools {
  /** Its own version. */
  public static final Tool<Map<String, Object>, Map<String, Object>> OWN = Tool.define("acme.own")
      .version("2.1.0")
      .handler((input, ctx) -> Map.of());
  /** No version of its own: it takes the pack's. */
  public static final Tool<Map<String, Object>, Map<String, Object>> PACKS = Tool.define("acme.packs")
      .handler((input, ctx) -> Map.of());
  public static final Tool<Map<String, Object>, Map<String, Object>> SHORT = Tool.define("acme.short-tool")
      .version("1.0")
      .handler((input, ctx) -> Map.of());
  public static final Tool<Map<String, Object>, Map<String, Object>> LEADING_ZERO = Tool.define("acme.leading-zero-tool")
      .version("01.0.0")
      .handler((input, ctx) -> Map.of());
  /** An exact semver, but a tool's version is MAJOR.MINOR.PATCH only. */
  public static final Tool<Map<String, Object>, Map<String, Object>> PRERELEASE = Tool.define("acme.prerelease-tool")
      .version("2.1.0-rc.1")
      .handler((input, ctx) -> Map.of());

  private Tools() {}
}
