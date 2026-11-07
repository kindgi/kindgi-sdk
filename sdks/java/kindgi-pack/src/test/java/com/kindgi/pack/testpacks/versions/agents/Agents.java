// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.versions.agents;

import com.kindgi.pack.Agent;

public final class Agents {
  public static final Agent PLAIN = agent("acme.plain", "1.0.0");
  public static final Agent PRERELEASE = agent("acme.prerelease", "1.0.0-rc.1");
  public static final Agent BUILD = agent("acme.build", "1.0.0+build.5");
  public static final Agent SHORT = agent("acme.short", "0.1");
  public static final Agent LEADING_ZERO = agent("acme.leading-zero", "01.0.0");
  public static final Agent PREFIXED = agent("acme.prefixed", "v1.0.0");
  public static final Agent TRAILING = agent("acme.trailing", "1.0.0 beta");

  private Agents() {}

  private static Agent agent(String id, String version) {
    return Agent.define(id).version(version).name(id).instructions("Answer.").build();
  }
}
