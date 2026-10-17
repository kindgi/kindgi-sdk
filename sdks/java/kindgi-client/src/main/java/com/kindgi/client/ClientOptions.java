// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import com.kindgi.client.internal.RuntimeSettings;
import com.kindgi.client.internal.Transport;
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/** What a client builder collects; shared by {@link Kindgi} and {@link KindgiAsync}. */
final class ClientOptions {
  @Nullable String baseUrl;
  @Nullable String token;
  Duration timeout = Transport.DEFAULT_TIMEOUT;
  int maxRetries = Transport.DEFAULT_MAX_RETRIES;
  final Map<String, String> headers = new LinkedHashMap<>();
  @Nullable HttpClient httpClient;

  void header(String name, String value) {
    headers.put(Objects.requireNonNull(name, "name"), Objects.requireNonNull(value, "value"));
  }

  Transport transport() {
    RuntimeSettings.Settings s = RuntimeSettings.resolve(baseUrl, token);
    return new Transport(s.baseUrl(), s.token(), timeout, maxRetries, headers, httpClient);
  }
}
