// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import com.kindgi.client.internal.Transport;
import java.net.http.HttpClient;
import java.time.Duration;

/**
 * The Kindgi API, synchronously.
 *
 * <pre>{@code
 * Kindgi client = Kindgi.create(); // KINDGI_API_URL, KINDGI_API_TOKEN; in development, kindgi dev
 * Run run = client.runs().start(StartRunBody.WithAgent.builder()
 *     .agent("acme.bookkeeper")
 *     .input(Map.of("userMessage", "hi"))
 *     .build());
 * }</pre>
 *
 * <p>Resources follow the API's operation ids: {@code approvals.reviewers.list} is {@code
 * client.approvals().reviewers().list()}. Every failure is a typed {@link KindgiApiException}.
 * {@link #async()} is the same API with {@link java.util.concurrent.CompletableFuture}s.
 *
 * <p>A client is thread-safe; make one and share it.
 */
public final class Kindgi extends KindgiApi {
  private final Transport transport;

  private Kindgi(Transport transport) {
    super(transport);
    this.transport = transport;
  }

  /**
   * A client from the environment: {@code KINDGI_API_URL} and {@code KINDGI_API_TOKEN}; in
   * development, when they're unset, the running {@code kindgi dev} (the nearest {@code
   * .kindgirc.json}), with a warning to put them in your env file. Production ({@code KINDGI_ENV}
   * or {@code NODE_ENV} set to {@code production}) never reads {@code .kindgirc.json}.
   *
   * @return the client
   * @throws IllegalStateException when no URL or token can be found
   */
  public static Kindgi create() {
    return builder().build();
  }

  /** @return a builder; anything left unset is found as {@link #create()} finds it */
  public static Builder builder() {
    return new Builder();
  }

  /** @return the same API, asynchronously, sharing this client's connections and settings */
  public KindgiAsync async() {
    return new KindgiAsync(transport);
  }

  /** @return the runtime's URL */
  public String baseUrl() {
    return transport.baseUrl();
  }

  /** Builds a {@link Kindgi}. */
  public static final class Builder {
    private final ClientOptions options = new ClientOptions();

    private Builder() {}

    /**
     * @param baseUrl the runtime's URL ({@code http://127.0.0.1:4000})
     * @return this
     */
    public Builder baseUrl(String baseUrl) {
      options.baseUrl = baseUrl;
      return this;
    }

    /**
     * @param token the API token
     * @return this
     */
    public Builder token(String token) {
      options.token = token;
      return this;
    }

    /**
     * @param timeout a call's timeout (default 60 s)
     * @return this
     */
    public Builder timeout(Duration timeout) {
      options.timeout = timeout;
      return this;
    }

    /**
     * @param maxRetries retries after the first attempt, for a call that's safe to repeat
     *     (default 2)
     * @return this
     */
    public Builder maxRetries(int maxRetries) {
      options.maxRetries = maxRetries;
      return this;
    }

    /**
     * @param name a header sent with every call
     * @param value its value
     * @return this
     */
    public Builder header(String name, String value) {
      options.header(name, value);
      return this;
    }

    /**
     * @param httpClient the JDK HTTP client to use (a proxy, TLS settings, an executor)
     * @return this
     */
    public Builder httpClient(HttpClient httpClient) {
      options.httpClient = httpClient;
      return this;
    }

    /**
     * @return the client
     * @throws IllegalStateException when no URL or token can be found
     */
    public Kindgi build() {
      return new Kindgi(options.transport());
    }
  }
}
