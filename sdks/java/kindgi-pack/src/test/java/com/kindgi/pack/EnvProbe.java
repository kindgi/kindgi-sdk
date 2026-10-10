// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import java.util.TreeSet;

/** Run through the launcher by {@link PackEnvTest}: prints the names the JVM's environment holds, and the dropped ones it was handed. */
public final class EnvProbe {
  private EnvProbe() {}

  public static void main(String[] args) {
    System.out.println("names=" + String.join(",", new TreeSet<>(System.getenv().keySet())));
    System.out.println("dropped=" + System.getProperty(PackEnv.DROPPED_PROPERTY));
  }
}
