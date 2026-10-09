// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.internal.codec;

import java.util.function.Function;
import tools.jackson.core.JsonGenerator;
import tools.jackson.core.JsonParser;
import tools.jackson.core.JsonToken;
import tools.jackson.databind.DeserializationContext;
import tools.jackson.databind.SerializationContext;
import tools.jackson.databind.deser.std.StdDeserializer;
import tools.jackson.databind.module.SimpleModule;
import tools.jackson.databind.ser.std.StdSerializer;

/** The client's codec for the models' enum classes: each is its text ({@code "running"}). */
public final class TextValues {
  private TextValues() {}

  /**
   * @param <T> the enum class
   * @param module the client's module
   * @param type the enum class
   * @param of its text → value (any text: an unknown one is kept)
   * @param asString its value → text
   */
  public static <T> void register(SimpleModule module, Class<T> type, Function<String, T> of, Function<T, String> asString) {
    module.addSerializer(
        type,
        new StdSerializer<T>(type) {
          @Override
          public void serialize(T value, JsonGenerator gen, SerializationContext ctxt) {
            gen.writeString(asString.apply(value));
          }
        });
    module.addDeserializer(
        type,
        new StdDeserializer<T>(type) {
          @Override
          public T deserialize(JsonParser p, DeserializationContext ctxt) {
            if (p.currentToken() != JsonToken.VALUE_STRING) {
              @SuppressWarnings("unchecked")
              T refused = (T) ctxt.handleUnexpectedToken(type, p);
              return refused;
            }
            return of.apply(p.getString());
          }
        });
  }
}
