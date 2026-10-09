// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.bad.flows;

import com.kindgi.pack.Flow;
import java.util.Map;

public final class BadFlow {
  public static final Flow FLOW = Flow.define("acme.bad-flow")
      .version("1.0.0")
      .node(Map.of("id", "x", "kind", "toool", "ref", "acme.dup"))
      .edge("e1", "$start", "x")
      .edge("e2", "x", "$end")
      .build();
}
