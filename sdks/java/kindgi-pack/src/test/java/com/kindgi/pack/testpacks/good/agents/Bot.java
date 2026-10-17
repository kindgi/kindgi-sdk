// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.good.agents;

import com.kindgi.pack.Agent;
import com.kindgi.pack.testpacks.good.guardrails.Checks;
import com.kindgi.pack.testpacks.good.tools.Greet;

public final class Bot {
  public record Answer(String text) {}

  public static final Agent AGENT = Agent.define("acme.bot")
      .version("1.0.0")
      .name("Bot")
      .instructions("Greet.")
      .tool(Greet.TOOL)
      .tool("other.tool", "^1.0.0")
      .guardrail(Checks.NOT_EMPTY)
      .output(Answer.class)
      .build();
}
