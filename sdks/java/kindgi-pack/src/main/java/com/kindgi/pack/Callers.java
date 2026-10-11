// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import java.util.Set;

/**
 * The class a primitive is defined in: the first caller outside the packages that build primitives
 * for their callers. Those are this package and the language layers kindgi ships
 * ({@code com.kindgi.pack.scaladsl}, kindgi-pack-scala's), so a Scala object that calls the Scala
 * layer is the class its tools are defined in, as a Java class that calls {@code Tool.define} is.
 */
final class Callers {
  private static final Set<String> BUILDERS = Set.of("com.kindgi.pack", "com.kindgi.pack.scaladsl");
  private static final StackWalker WALKER = StackWalker.getInstance(StackWalker.Option.RETAIN_CLASS_REFERENCE);

  private Callers() {}

  /** @return the first class on the stack outside the builders' packages */
  static Class<?> definer() {
    return WALKER.walk(frames -> frames
        .map(StackWalker.StackFrame::getDeclaringClass)
        .filter(c -> !BUILDERS.contains(c.getPackageName()))
        .findFirst()
        .orElseThrow(() -> new IllegalStateException("a primitive defined with no caller outside kindgi-pack")));
  }
}
