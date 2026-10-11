// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.internal;

import static org.assertj.core.api.Assertions.assertThat;

import com.kindgi.client.Kindgi;
import com.kindgi.client.KindgiAsync;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Flow;
import org.junit.jupiter.api.Test;

/**
 * The client is in step with the API: every operation of {@code packages/api/openapi.json} has a
 * method (sync and async) at its operation id's place in the resource tree, with its HTTP method
 * and path, and the client has no operation the document doesn't.
 */
class OperationCoverageTest {
  private static final Path OPENAPI = Path.of(System.getProperty("kindgi.openapi", "../../../packages/api/openapi.json"));

  @SuppressWarnings("unchecked")
  private static Map<String, Object> document() {
    return Json.mapper().readValue(OPENAPI.toFile(), Map.class);
  }

  /** operationId → {method, path}. */
  @SuppressWarnings("unchecked")
  private static Map<String, String[]> operations() {
    Map<String, String[]> out = new java.util.LinkedHashMap<>();
    Map<String, Object> paths = (Map<String, Object>) document().get("paths");
    for (Map.Entry<String, Object> p : paths.entrySet()) {
      for (Map.Entry<String, Object> m : ((Map<String, Object>) p.getValue()).entrySet()) {
        if (m.getValue() instanceof Map && ((Map<String, Object>) m.getValue()).containsKey("operationId")) {
          out.put((String) ((Map<String, Object>) m.getValue()).get("operationId"), new String[] {m.getKey().toUpperCase(Locale.ROOT), p.getKey()});
        }
      }
    }
    return out;
  }

  @Test
  void everyOperationIsInTheTableWithItsMethodAndPath() {
    Map<String, String[]> ops = operations();
    List<String> missing = new ArrayList<>();
    for (Map.Entry<String, String[]> e : ops.entrySet()) {
      if (Operations.WITHOUT_METHOD.contains(e.getKey())) {
        assertThat(e.getValue()[0]).as(e.getKey()).isEqualTo("HEAD");
        continue;
      }
      Operation op = Operations.ALL.get(e.getKey());
      if (op == null) {
        missing.add(e.getKey());
        continue;
      }
      assertThat(op.method()).as(e.getKey()).isEqualTo(e.getValue()[0]);
      assertThat(op.path()).as(e.getKey()).isEqualTo(e.getValue()[1]);
    }
    assertThat(missing).as("operations without a client method").isEmpty();
    assertThat(ops.keySet()).as("the client's operations are the document's").containsAll(Operations.ALL.keySet());
  }

  @Test
  void everyOperationHasASyncAndAnAsyncMethod() throws Exception {
    List<String> problems = new ArrayList<>();
    for (String id : Operations.ALL.keySet()) {
      check(Kindgi.class, id, false, problems);
      check(KindgiAsync.class, id, true, problems);
    }
    assertThat(problems).isEmpty();
  }

  private static void check(Class<?> client, String id, boolean async, List<String> problems) throws Exception {
    String[] parts = id.split("\\.");
    Class<?> at = client;
    for (int i = 0; i < parts.length - 1; i++) {
      Method accessor = at.getMethod(camel(parts[i]));
      at = accessor.getReturnType();
    }
    String name = camel(parts[parts.length - 1]);
    Method[] methods = Arrays.stream(at.getMethods()).filter(m -> m.getName().equals(name) && Modifier.isPublic(m.getModifiers())).toArray(Method[]::new);
    if (methods.length == 0) {
      problems.add((async ? "async " : "") + id + ": no method " + at.getSimpleName() + "." + name);
      return;
    }
    for (Method m : methods) {
      boolean returnsAsync = CompletableFuture.class.isAssignableFrom(m.getReturnType()) || Flow.Publisher.class.isAssignableFrom(m.getReturnType());
      if (returnsAsync != async) {
        problems.add(id + ": " + m + " is " + (async ? "not " : "") + "asynchronous");
      }
    }
  }

  private static String camel(String s) {
    return Character.toLowerCase(s.charAt(0)) + s.substring(1);
  }
}
