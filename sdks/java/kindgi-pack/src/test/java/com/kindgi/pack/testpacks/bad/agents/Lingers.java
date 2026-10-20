// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.bad.agents;

import com.kindgi.pack.Agent;
import java.util.Map;

/** Sets {@code autoCloseAfterInactiveSeconds}, which isn't supported: the indexer refuses it. */
public final class Lingers {
  public static final Agent AGENT = Agent.define("acme.lingers")
      .version("1.0.0")
      .name("Lingers")
      .instructions("Wait.")
      .set("conversationPolicy", Map.of("historyLimit", 5, "autoCloseAfterInactiveSeconds", 600))
      .build();
}
