// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.flows;

import com.kindgi.pack.Flow;
import java.util.Map;

/** Its steps form a cycle: a -> b -> a. */
public final class CycleFlow {
  public static final Flow FLOW = Flow.define("conformance.cycle-flow")
      .version("1.0.0")
      .node(Map.of("id", "a", "kind", "tool", "ref", "conformance.echo"))
      .node(Map.of("id", "b", "kind", "tool", "ref", "conformance.echo"))
      .edge("e-start", "$start", "a")
      .edge("e-a-b", "a", "b")
      .edge("e-b-a", "b", "a")
      .edge("e-end", "b", "$end")
      .build();
}
