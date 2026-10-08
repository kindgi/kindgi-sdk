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
      .edge(Map.of("id", "e1", "from", "$start", "to", "greet",
          "policy", Map.of("retry", Map.of("maxAttempts", 2))))
      .edge(Map.of("id", "e2", "from", "greet", "to", "$end",
          "when", Map.of("op", "exists", "value", Map.of("path", "nodeOutputs.greet.message"))))
      .set("metadata", Map.of("tags", List.of("demo")))
      .build();
}
