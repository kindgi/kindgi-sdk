// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.internal.codec;

import com.kindgi.client.models.OptionalNullable;
import org.jspecify.annotations.Nullable;
import tools.jackson.core.JsonGenerator;
import tools.jackson.core.JsonParser;
import tools.jackson.databind.BeanProperty;
import tools.jackson.databind.DeserializationContext;
import tools.jackson.databind.JavaType;
import tools.jackson.databind.SerializationContext;
import tools.jackson.databind.ValueDeserializer;
import tools.jackson.databind.deser.std.StdDeserializer;
import tools.jackson.databind.module.SimpleModule;
import tools.jackson.databind.ser.std.StdSerializer;

/**
 * The client's codec for {@link OptionalNullable}: a value, or {@code null}; an absent one isn't
 * written (its property carries an inclusion filter). Read back, a left-out property is absent and
 * an explicit {@code null} stays an explicit {@code null}.
 */
public final class OptionalNullableCodec {
  private OptionalNullableCodec() {}

  /** @param module the client's module */
  @SuppressWarnings({"rawtypes", "unchecked"})
  public static void register(SimpleModule module) {
    module.addSerializer(OptionalNullable.class, new Writer());
    module.addDeserializer((Class) OptionalNullable.class, new Reader(null));
  }

  @SuppressWarnings("rawtypes")
  private static final class Writer extends StdSerializer<OptionalNullable> {
    Writer() {
      super(OptionalNullable.class);
    }

    @Override
    public void serialize(OptionalNullable value, JsonGenerator gen, SerializationContext ctxt) {
      Object inner = value.jsonValue();
      if (inner == null) {
        gen.writeNull();
      } else {
        ctxt.writeValue(gen, inner);
      }
    }
  }

  private static final class Reader extends StdDeserializer<OptionalNullable<?>> {
    private final @Nullable JavaType inner;

    Reader(@Nullable JavaType inner) {
      super(OptionalNullable.class);
      this.inner = inner;
    }

    @Override
    public ValueDeserializer<?> createContextual(DeserializationContext ctxt, @Nullable BeanProperty property) {
      JavaType type = property != null ? property.getType() : ctxt.getContextualType();
      JavaType contained = type == null ? null : type.containedType(0);
      return new Reader(contained != null ? contained : ctxt.constructType(Object.class));
    }

    @Override
    public OptionalNullable<?> deserialize(JsonParser p, DeserializationContext ctxt) {
      return OptionalNullable.of(ctxt.readValue(p, inner != null ? inner : ctxt.constructType(Object.class)));
    }

    @Override
    public Object getNullValue(DeserializationContext ctxt) {
      return OptionalNullable.of(null);
    }

    @Override
    public Object getAbsentValue(DeserializationContext ctxt) {
      return OptionalNullable.absent();
    }
  }
}
