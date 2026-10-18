// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.kindgi.client.models.Model;
import com.kindgi.client.models.ValidationException;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * The cases the Python client replays too (packages/specs/test-vectors/open-values): a request
 * body holding a value this client doesn't know is refused before it's sent, naming where the value
 * is and the values it knows.
 */
class KnownValuesVectorsTest {
  private static final Path CASES = Path.of("../../../packages/specs/test-vectors/open-values/cases.json");

  private HttpServer server;
  private final AtomicInteger requests = new AtomicInteger();
  private Kindgi client;

  @SuppressWarnings("unchecked")
  static List<Map<String, Object>> read() throws IOException {
    return (List<Map<String, Object>>) KindgiJson.read(Files.readString(CASES, StandardCharsets.UTF_8), List.class);
  }

  static Stream<Arguments> cases() throws IOException {
    return read().stream().map(c -> Arguments.of(c.get("name"), c));
  }

  @BeforeEach
  void start() throws IOException {
    server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext(
        "/",
        exchange -> {
          requests.incrementAndGet();
          exchange.sendResponseHeaders(500, -1);
          exchange.close();
        });
    server.start();
    client =
        Kindgi.builder()
            .baseUrl("http://127.0.0.1:" + server.getAddress().getPort() + "/")
            .token("kgi_test")
            .timeout(Duration.ofSeconds(5))
            .build();
  }

  @AfterEach
  void stop() {
    server.stop(0);
  }

  @Test
  void theCasesAreThere() throws IOException {
    assertThat(read()).hasSizeGreaterThanOrEqualTo(5);
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("cases")
  @SuppressWarnings("unchecked")
  void eachCaseIsRefusedBeforeItsSent(String name, Map<String, Object> c) throws Exception {
    // The resource the operation names (`agents.live.unpin`: agents(), then live()), and its
    // method that takes the arguments and then the body (a model, where another overload takes
    // the query parameters).
    String[] parts = ((String) c.get("operation")).split("\\.");
    Object resource = client;
    for (int i = 0; i < parts.length - 1; i++) {
      resource = resource.getClass().getMethod(parts[i]).invoke(resource);
    }
    List<Object> args = (List<Object>) c.get("args");
    Method method = null;
    for (Method m : resource.getClass().getMethods()) {
      if (m.getName().equals(parts[parts.length - 1])
          && m.getParameterCount() == args.size() + 1
          && m.getParameterTypes()[args.size()].getPackageName().equals(Model.class.getPackageName())) {
        method = m;
      }
    }
    assertThat(method).as((String) c.get("operation")).isNotNull();
    Class<?>[] types = method.getParameterTypes();
    List<Object> call = new ArrayList<>();
    for (int i = 0; i < args.size(); i++) {
      call.add(types[i] == UUID.class ? UUID.fromString((String) args.get(i)) : args.get(i));
    }
    call.add(KindgiJson.read(KindgiJson.write(c.get("body")), types[types.length - 1]));

    // Where the value is, as this client writes it: `events[1]`, and the tag for a union variant.
    StringBuilder at = new StringBuilder();
    for (Object step : (List<Object>) c.get("at")) {
      if (step instanceof Number) {
        at.append('[').append(step).append(']');
      } else {
        at.append(at.length() == 0 ? "" : ".").append(step);
      }
    }
    if (c.get("tag") != null) {
      at.append('.').append(c.get("tag"));
    }

    Method send = method;
    Object target = resource;
    assertThatThrownBy(
            () -> {
              try {
                send.invoke(target, call.toArray());
              } catch (InvocationTargetException e) {
                throw e.getCause();
              }
            })
        .isInstanceOfSatisfying(
            ValidationException.class,
            e -> {
              String marker = " is invalid: " + at + ": must be one of ";
              assertThat(e.getMessage()).contains(marker);
              String known = e.getMessage().substring(e.getMessage().indexOf(marker) + marker.length());
              int end = known.indexOf("; ");
              assertThat((end < 0 ? known : known.substring(0, end)).split(", ")).contains((String) c.get("names"));
            });
    assertThat(requests).hasValue(0);
  }
}
