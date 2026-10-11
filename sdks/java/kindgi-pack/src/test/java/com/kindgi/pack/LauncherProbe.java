// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import java.util.List;

/** Run through the launcher by {@link PackServiceTest}: prints the token the service reads, and whether the environment still holds it. */
public final class LauncherProbe {
  private LauncherProbe() {}

  public static void main(String[] args) {
    Object config = Serve.readConfig(List.of(), System.getenv(), System.getProperty("kindgi.pack.tokenFd"));
    System.out.println(config instanceof Serve.Config ? "token=" + ((Serve.Config) config).token() : "problems=" + config);
    System.out.println("inEnv=" + System.getenv().containsKey("KINDGI_PACK_SERVICE_TOKEN"));
  }
}
