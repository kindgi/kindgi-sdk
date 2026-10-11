// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.internal;

import java.io.IOException;
import java.io.InputStream;
import java.util.Properties;

/** This client's version, from the build. */
public final class Version {
  private Version() {}

  /** The version ({@code 0.1.6}), or {@code unknown} outside a build. */
  public static final String VERSION = load();

  private static String load() {
    try (InputStream in = Version.class.getResourceAsStream("version.properties")) {
      if (in == null) {
        return "unknown";
      }
      Properties p = new Properties();
      p.load(in);
      String v = p.getProperty("version", "unknown");
      return v.startsWith("${") ? "unknown" : v;
    } catch (IOException e) {
      return "unknown";
    }
  }
}
