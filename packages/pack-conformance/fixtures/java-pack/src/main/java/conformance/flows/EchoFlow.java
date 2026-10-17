// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.flows;

import com.kindgi.pack.Flow;
import conformance.tools.Echo;

public final class EchoFlow {
  public static final Flow FLOW = Flow.define("conformance.echo-flow")
      .version("1.0.0")
      .toolNode("echo", Echo.TOOL)
      .edge("e-start", "$start", "echo")
      .edge("e-end", "echo", "$end")
      .build();
}
