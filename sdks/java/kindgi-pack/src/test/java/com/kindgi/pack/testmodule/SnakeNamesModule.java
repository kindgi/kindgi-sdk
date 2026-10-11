// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testmodule;

import com.fasterxml.jackson.core.Version;
import com.fasterxml.jackson.databind.Module;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.introspect.AnnotatedClass;
import com.fasterxml.jackson.databind.introspect.NopAnnotationIntrospector;

/**
 * An app's own Jackson module, declared in the test classpath's {@code META-INF/services}: classes
 * marked {@link SnakeNames} name their properties in snake_case. The binding mapper finds it; the
 * wire's mapper doesn't.
 */
public final class SnakeNamesModule extends Module {
  @Override
  public String getModuleName() {
    return "acme-snake-names";
  }

  @Override
  public Version version() {
    return Version.unknownVersion();
  }

  @Override
  public void setupModule(SetupContext context) {
    context.insertAnnotationIntrospector(new NopAnnotationIntrospector() {
      private static final long serialVersionUID = 1L;

      @Override
      public Object findNamingStrategy(AnnotatedClass ac) {
        return ac.hasAnnotation(SnakeNames.class) ? PropertyNamingStrategies.SNAKE_CASE : null;
      }
    });
  }
}
