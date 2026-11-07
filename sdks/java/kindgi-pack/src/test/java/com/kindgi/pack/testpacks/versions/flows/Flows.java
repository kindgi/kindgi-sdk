// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.versions.flows;

import com.kindgi.pack.Flow;
import com.kindgi.pack.testpacks.versions.tools.Tools;

public final class Flows {
  public static final Flow PLAIN = flow("acme.plain-flow", "1.0.0");
  /** The flow schema's own pattern refuses it first. */
  public static final Flow SHORT = flow("acme.short-flow", "1.0");
  /** The flow schema's pattern takes it; an exact semver has no leading zero. */
  public static final Flow LEADING_ZERO = flow("acme.leading-zero-flow", "01.0.0");

  private Flows() {}

  private static Flow flow(String id, String version) {
    return Flow.define(id)
        .version(version)
        .toolNode("look", Tools.OWN)
        .edge("e-start", "$start", "look")
        .edge("e-end", "look", "$end")
        .build();
  }
}
