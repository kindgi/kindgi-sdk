// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.scalalike.tools;

import com.kindgi.pack.Tool;
import com.kindgi.pack.scaladsl.ScalaLayer;
import java.util.Map;

/**
 * What scalac makes of {@code object Greet { val tool = … }} in Greet.scala: the class {@code
 * Greet$}, its instance in {@code MODULE$}, the val a private field with an accessor.
 */
public final class Greet$ {
  public static final Greet$ MODULE$ = new Greet$();

  private final Tool<Map<String, Object>, Map<String, Object>> tool;

  private Greet$() {
    tool = ScalaLayer.greeter("acme.scala-greet");
  }

  public Tool<Map<String, Object>, Map<String, Object>> tool() {
    return tool;
  }
}
