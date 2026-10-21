// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.http;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * An HTTP tool declared as data: the method, URL template and options the Kindgi runtime uses to
 * make the request. The Java SDK does not make the request itself — it builds and validates the
 * spec, and the runtime calls it. Pass one to {@code Tool.define(id)....http(spec)} (see {@code
 * com.kindgi.pack.Tool.Builder#http}).
 *
 * <p>The Java counterpart of the TypeScript {@code HttpToolSpec} and Python's {@code http_tool}.
 * {@code {placeholders}} in the URL template (and in a {@link HttpRequestBodySpec.Text} body) are
 * filled from the tool's input fields; they are allowed only in the path and query, never in the
 * host or port.
 */
public final class HttpToolSpec {

  private final HttpMethod method;
  private final String urlTemplate;
  private final List<HttpHeaderSpec> headers;
  private final @Nullable HttpAuthSpec authorization;
  private final @Nullable HttpRequestBodySpec requestBody;
  private final @Nullable Integer timeoutMs;
  private final @Nullable Boolean parseJson;
  private final @Nullable SuccessStatus successStatus;

  private HttpToolSpec(Builder b) {
    this.method = Objects.requireNonNull(b.method, "method");
    this.urlTemplate = Objects.requireNonNull(b.urlTemplate, "urlTemplate");
    this.headers = List.copyOf(b.headers);
    this.authorization = b.authorization;
    this.requestBody = b.requestBody;
    this.timeoutMs = b.timeoutMs;
    this.parseJson = b.parseJson;
    this.successStatus = b.successStatus;
  }

  /** @return a new builder */
  public static Builder builder() {
    return new Builder();
  }

  public HttpMethod method() {
    return method;
  }

  public String urlTemplate() {
    return urlTemplate;
  }

  /** @return the headers to send, in order; empty when none */
  public List<HttpHeaderSpec> headers() {
    return headers;
  }

  public @Nullable HttpAuthSpec authorization() {
    return authorization;
  }

  public @Nullable HttpRequestBodySpec requestBody() {
    return requestBody;
  }

  public @Nullable Integer timeoutMs() {
    return timeoutMs;
  }

  public @Nullable Boolean parseJson() {
    return parseJson;
  }

  public @Nullable SuccessStatus successStatus() {
    return successStatus;
  }

  /**
   * @return the spec as the ordered map the pack index carries under a tool's {@code spec} field;
   *     options left unset are left out
   */
  public Map<String, Object> toIndexMap() {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("kind", "http");
    m.put("method", method.name());
    m.put("urlTemplate", urlTemplate);
    if (!headers.isEmpty()) {
      List<Map<String, Object>> hs = new ArrayList<>();
      for (HttpHeaderSpec h : headers) {
        Map<String, Object> hm = new LinkedHashMap<>();
        hm.put("name", h.name());
        hm.put("value", h.value());
        hs.add(hm);
      }
      m.put("headers", hs);
    }
    if (authorization != null) {
      m.put("authorization", authMap(authorization));
    }
    if (requestBody != null) {
      m.put("requestBody", bodyMap(requestBody));
    }
    if (timeoutMs != null) {
      m.put("timeoutMs", timeoutMs);
    }
    if (parseJson != null) {
      m.put("parseJson", parseJson);
    }
    if (successStatus != null) {
      Map<String, Object> sm = new LinkedHashMap<>();
      sm.put("min", successStatus.min());
      sm.put("max", successStatus.max());
      m.put("successStatus", sm);
    }
    return m;
  }

  private static Map<String, Object> authMap(HttpAuthSpec auth) {
    Map<String, Object> m = new LinkedHashMap<>();
    if (auth instanceof HttpAuthSpec.Bearer bearer) {
      m.put("kind", "bearer");
      m.put("secretRef", secretRefMap(bearer.secretRef()));
    } else {
      HttpAuthSpec.Header header = (HttpAuthSpec.Header) auth;
      m.put("kind", "header");
      m.put("headerName", header.headerName());
      m.put("secretRef", secretRefMap(header.secretRef()));
    }
    return m;
  }

  private static Map<String, Object> secretRefMap(ToolSecretRef ref) {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("envName", ref.envName());
    m.put("name", ref.name());
    return m;
  }

  private static Map<String, Object> bodyMap(HttpRequestBodySpec body) {
    Map<String, Object> m = new LinkedHashMap<>();
    if (body instanceof HttpRequestBodySpec.JsonInput) {
      m.put("kind", "json-input");
    } else if (body instanceof HttpRequestBodySpec.InputPassthrough) {
      m.put("kind", "input-passthrough");
    } else {
      HttpRequestBodySpec.Text text = (HttpRequestBodySpec.Text) body;
      m.put("kind", "text");
      m.put("template", text.template());
    }
    return m;
  }

  /** Builds an {@link HttpToolSpec}. */
  public static final class Builder {
    private @Nullable HttpMethod method;
    private @Nullable String urlTemplate;
    private final List<HttpHeaderSpec> headers = new ArrayList<>();
    private @Nullable HttpAuthSpec authorization;
    private @Nullable HttpRequestBodySpec requestBody;
    private @Nullable Integer timeoutMs;
    private @Nullable Boolean parseJson;
    private @Nullable SuccessStatus successStatus;

    private Builder() {}

    /** @param method the HTTP method (required) */
    public Builder method(HttpMethod method) {
      this.method = method;
      return this;
    }

    /**
     * @param urlTemplate the URL (required); {@code {placeholders}} in the path and query are filled
     *     from the tool's input fields
     */
    public Builder urlTemplate(String urlTemplate) {
      this.urlTemplate = urlTemplate;
      return this;
    }

    /**
     * Adds a header the runtime sends, in order. HTTP header names are case-insensitive, so a name
     * already added (ignoring case) is refused rather than sent twice.
     *
     * @throws IllegalArgumentException when a header with this name (ignoring case) was already added
     */
    public Builder header(String name, String value) {
      HttpHeaderSpec header = new HttpHeaderSpec(name, value);
      for (HttpHeaderSpec existing : headers) {
        if (existing.name().equalsIgnoreCase(header.name())) {
          throw new IllegalArgumentException(
              "header \"" + name + "\" was already set (header names are case-insensitive)");
        }
      }
      this.headers.add(header);
      return this;
    }

    /** @param authorization how the runtime authorizes the request */
    public Builder authorization(HttpAuthSpec authorization) {
      this.authorization = authorization;
      return this;
    }

    /** @param requestBody what the runtime sends as the request body */
    public Builder requestBody(HttpRequestBodySpec requestBody) {
      this.requestBody = requestBody;
      return this;
    }

    /** @param timeoutMs the request timeout in milliseconds (default 30000) */
    public Builder timeoutMs(int timeoutMs) {
      this.timeoutMs = timeoutMs;
      return this;
    }

    /** @param parseJson whether to parse the response body as JSON (default true) */
    public Builder parseJson(boolean parseJson) {
      this.parseJson = parseJson;
      return this;
    }

    /** The inclusive HTTP status-code range the runtime treats as success (default 200–299). */
    public Builder successStatus(int min, int max) {
      this.successStatus = new SuccessStatus(min, max);
      return this;
    }

    /** @return the built spec */
    public HttpToolSpec build() {
      return new HttpToolSpec(this);
    }
  }
}
