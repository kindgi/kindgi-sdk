// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testmodule;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.deser.std.StdDeserializer;
import com.fasterxml.jackson.databind.module.SimpleModule;
import java.io.IOException;

/**
 * Does to untyped values what Scala's Jackson module does (it reads them as Scala collections):
 * here, a JSON object or array read as {@code Object} becomes an {@link Untyped}, which is no Java
 * collection. Declared in the test classpath's {@code META-INF/services}, so a plain value that
 * goes through the binding mapper's untyped reading shows.
 */
public final class UntypedModule extends SimpleModule {
  private static final long serialVersionUID = 1L;

  /** A JSON object or array, read as something else. */
  public record Untyped(String json) {}

  public UntypedModule() {
    super("acme-untyped");
    addDeserializer(Object.class, new StdDeserializer<>(Object.class) {
      private static final long serialVersionUID = 1L;

      @Override
      public Object deserialize(JsonParser p, DeserializationContext ctxt) throws IOException {
        JsonNode node = ctxt.readTree(p);
        if (node.isObject() || node.isArray()) {
          return new Untyped(node.toString());
        }
        if (node.isNull()) {
          return null;
        }
        return node.isTextual() ? node.textValue() : node.isBoolean() ? (Object) node.booleanValue() : node.numberValue();
      }
    });
  }
}
