// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import com.kindgi.client.internal.Transport;
import java.net.http.HttpClient;
import java.time.Duration;

/**
 * The Kindgi API, asynchronously: every call answers a {@link
 * java.util.concurrent.CompletableFuture}, and a stream of events is a {@link
 * java.util.concurrent.Flow.Publisher}.
 *
 * <pre>{@code
 * KindgiAsync client = KindgiAsync.create();
 * client.runs().get(runId).thenAccept(run -> System.out.println(run.status()));
 * }</pre>
 *
 * <p>A failed call completes its future exceptionally with a typed {@link KindgiApiException}.
 */
public final class KindgiAsync extends KindgiAsyncApi {
  private final Transport transport;

  KindgiAsync(Transport transport) {
    super(transport);
    this.transport = transport;
  }

  /**
   * A client from the environment, as {@link Kindgi#create()} finds it.
   *
   * @return the client
   * @throws IllegalStateException when no URL or token can be found
   */
  public static KindgiAsync create() {
    return builder().build();
  }

  /** @return a builder; anything left unset is found as {@link #create()} finds it */
  public static Builder builder() {
    return new Builder();
  }

  /** @return the runtime's URL */
  public String baseUrl() {
    return transport.baseUrl();
  }

  /** Builds a {@link KindgiAsync}. */
  public static final class Builder {
    private final ClientOptions options = new ClientOptions();

    private Builder() {}

    /**
     * @param baseUrl the runtime's URL
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
     * @param maxRetries retries after the first attempt (default 2)
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
     * @param httpClient the JDK HTTP client to use
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
    public KindgiAsync build() {
      return new KindgiAsync(options.transport());
    }
  }
}
