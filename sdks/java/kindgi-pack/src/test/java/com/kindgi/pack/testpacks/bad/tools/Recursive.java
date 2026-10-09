// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.bad.tools;

import com.kindgi.pack.Tool;
import java.util.List;
import java.util.Map;

public final class Recursive {
  public record Node(String name, List<Node> children) {}

  public static final Tool<Node, Map<String, Object>> TOOL = Tool.define("acme.recursive")
      .input(Node.class)
      .handler((input, ctx) -> Map.of());
}
