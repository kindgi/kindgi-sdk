// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.agents;

import com.kindgi.pack.Agent;
import conformance.guardrails.Checks;
import conformance.tools.Echo;
import java.util.List;
import java.util.Map;

public final class EchoAgent {
  public static final Agent AGENT = Agent.define("conformance.echo-agent")
      .version("1.0.0")
      .name("Echo agent")
      .instructions("Call conformance.echo with the message.")
      .capability(Map.of("needs", List.of(Map.of("feature", "tool-use"))))
      .tool(Echo.TOOL)
      .guardrail(Checks.MIN_LENGTH)
      .build();
}
