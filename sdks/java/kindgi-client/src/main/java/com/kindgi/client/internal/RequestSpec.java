// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.internal;

import java.util.AbstractMap;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/** One call, as a generated resource method describes it to the transport. */
public final class RequestSpec {
  final Operation operation;
  final Map<String, String> path = new LinkedHashMap<>();
  final List<Map.Entry<String, String>> query = new ArrayList<>();
  final Map<String, String> headers = new LinkedHashMap<>();
  @Nullable Object json;
  @Nullable Multipart multipart;

  private RequestSpec(Operation operation) {
    this.operation = operation;
  }

  /**
   * @param operation the operation
   * @return a call of it
   */
  public static RequestSpec of(Operation operation) {
    return new RequestSpec(Objects.requireNonNull(operation));
  }

  /** @return the operation */
  public Operation operation() {
    return operation;
  }

  /**
   * @param name the path parameter
   * @param value its value
   * @return this
   */
  public RequestSpec path(String name, Object value) {
    path.put(name, Wire.text(Objects.requireNonNull(value, name)));
    return this;
  }

  /**
   * A query parameter: left out when {@code null}, repeated for a collection.
   *
   * @param name the parameter
   * @param value its value
   * @return this
   */
  public RequestSpec query(String name, @Nullable Object value) {
    if (value instanceof Collection) {
      for (Object item : (Collection<?>) value) {
        if (item != null) {
          query.add(new AbstractMap.SimpleImmutableEntry<>(name, Wire.text(item)));
        }
      }
    } else if (value != null) {
      query.add(new AbstractMap.SimpleImmutableEntry<>(name, Wire.text(value)));
    }
    return this;
  }

  /**
   * A header: left out when {@code null}.
   *
   * @param name the header
   * @param value its value
   * @return this
   */
  public RequestSpec header(String name, @Nullable Object value) {
    if (value != null) {
      headers.put(name, Wire.text(value));
    }
    return this;
  }

  /**
   * A JSON body: a model (checked against the API's constraints before it's sent), or any value
   * Jackson writes. {@code null} sends no body.
   *
   * @param body the body
   * @return this
   */
  public RequestSpec json(@Nullable Object body) {
    this.json = body;
    return this;
  }

  /**
   * A multipart body.
   *
   * @param body the parts
   * @return this
   */
  public RequestSpec multipart(@Nullable Multipart body) {
    this.multipart = body;
    return this;
  }
}
