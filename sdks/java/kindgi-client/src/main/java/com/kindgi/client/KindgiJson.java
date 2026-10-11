// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import com.kindgi.client.internal.Json;
import java.nio.charset.StandardCharsets;
import java.util.Objects;
import tools.jackson.core.JacksonException;

/**
 * The models as JSON, exactly as the client reads and writes them: to store one, log one, or read
 * one a webhook sent.
 *
 * <pre>{@code
 * String json = KindgiJson.write(run);
 * Run again = KindgiJson.read(json, Run.class);
 * }</pre>
 *
 * <p>An app's own Jackson (Spring's, say) reads and writes the models too, through their
 * annotations.
 */
public final class KindgiJson {
  private KindgiJson() {}

  /**
   * @param value a model, or any value of the API (lists and maps of them)
   * @return its JSON
   * @throws KindgiJsonException when it can't be written
   */
  public static String write(Object value) {
    try {
      return Json.mapper().writeValueAsString(value);
    } catch (JacksonException e) {
      throw new KindgiJsonException("can't write " + value.getClass().getSimpleName() + " as JSON: " + e.getOriginalMessage(), e);
    }
  }

  /**
   * @param <T> the type
   * @param json the JSON
   * @param type the model (or {@code Map.class}, {@code Object.class}, …)
   * @return the value
   * @throws KindgiJsonException when the JSON isn't valid, or doesn't match the type (a required
   *     property missing, a wrong type)
   */
  public static <T> T read(String json, Class<T> type) {
    Objects.requireNonNull(json, "json");
    try {
      return Json.mapper().readValue(json, type);
    } catch (JacksonException e) {
      throw new KindgiJsonException("can't read a " + type.getSimpleName() + " from this JSON: " + e.getOriginalMessage(), e);
    }
  }

  /**
   * @param <T> the type
   * @param json the JSON, as UTF-8
   * @param type the model
   * @return the value
   * @throws KindgiJsonException when the JSON isn't valid, or doesn't match the type
   */
  public static <T> T read(byte[] json, Class<T> type) {
    return read(new String(json, StandardCharsets.UTF_8), type);
  }
}
