// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.scalalike.tools;

import com.kindgi.pack.Tool;
import com.kindgi.pack.scaladsl.ScalaLayer;
import java.util.Map;

/** {@code object Lazy { def tool = … }}: a tool no val holds, so the indexer can't read it. */
public final class Lazy$ {
  public static final Lazy$ MODULE$ = new Lazy$();

  private Lazy$() {}

  public Tool<Map<String, Object>, Map<String, Object>> tool() {
    return ScalaLayer.greeter("acme.lazy");
  }
}
