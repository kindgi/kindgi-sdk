// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.good.flows;

import com.kindgi.pack.Flow;
import com.kindgi.pack.testpacks.good.tools.Greet;
import java.util.List;
import java.util.Map;

public final class Pipeline {
  public static final Flow FLOW = Flow.define("acme.pipeline")
      .version("1.0.0")
      .node(Map.of("id", "greet", "kind", "tool", "ref", Greet.TOOL))
      .edge("e1", "$start", "greet")
      .edge("e2", "greet", "$end")
      .set("metadata", Map.of("tags", List.of("demo")))
      .build();
}
