// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.internal;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.kindgi.client.internal.codec.ModelCodecs;
import com.kindgi.client.internal.codec.OptionalNullableCodec;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.cfg.DateTimeFeature;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.module.SimpleModule;

/**
 * The client's JSON mapper. It's the client's own Jackson 3, shaded into its jar, so an app's
 * Jackson (2 or 3, any version) never meets it; it reads the models through generated mix-ins
 * ({@code ModelCodecs}), not through the models' own annotations (those are for the app's mapper).
 */
public final class Json {
  private Json() {}

  private static final ObjectMapper MAPPER = build();

  /** @return the mapper (thread-safe, shared) */
  public static ObjectMapper mapper() {
    return MAPPER;
  }

  private static ObjectMapper build() {
    SimpleModule models = new SimpleModule("kindgi-models");
    ModelCodecs.register(models);
    OptionalNullableCodec.register(models);
    return JsonMapper.builder()
        .addModule(models)
        // A newer runtime may add properties: ignore them.
        .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
        // Dates keep their offset, and are written as ISO-8601 text.
        .disable(DateTimeFeature.ADJUST_DATES_TO_CONTEXT_TIME_ZONE)
        .disable(DateTimeFeature.WRITE_DATES_AS_TIMESTAMPS)
        // A model's unset property isn't written (a map keeps its nulls).
        .changeDefaultPropertyInclusion(i -> i.withValueInclusion(JsonInclude.Include.NON_NULL))
        .build();
  }
}
