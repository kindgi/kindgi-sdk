// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.codegen;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * A query list sent as one key, its values comma-separated: {@code style: form} with {@code
 * explode: false}. Anything the generator wouldn't send as the spec says is refused.
 */
class CommaListTest {
  private static final Path API = Path.of("../../../packages/api/openapi.json");

  private static Map<String, Object> obj(Object... kv) {
    Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i < kv.length; i += 2) {
      m.put((String) kv[i], kv[i + 1]);
    }
    return m;
  }

  private static OperationPlanner plan(Map<String, Object> param) {
    Map<String, Object> op =
        obj(
            "operationId", "widgets.list", "summary", "s", "tags", List.of(), "security", List.of(),
            "parameters", List.of(param),
            "responses", obj("200", obj("description", "d", "content", obj("application/json", obj("schema", obj("type", "object"))))));
    Map<String, Object> d = new LinkedHashMap<>();
    d.put("openapi", "3.1.0");
    d.put("info", Map.of("title", "t", "version", "1"));
    d.put("paths", obj("/widgets", obj("get", op)));
    d.put("components", Map.of("schemas", Map.of()));
    return Generator.plan(d).operations();
  }

  private static Map<String, Object> include(String in, Map<String, Object> schema, Object... serialization) {
    Map<String, Object> p = obj("name", "include", "in", in, "schema", schema);
    p.putAll(obj(serialization));
    return p;
  }

  private static final Map<String, Object> ARRAY = obj("type", "array", "items", obj("type", "string", "enum", List.of("owner")));

  private static boolean comma(OperationPlanner ops) {
    return ops.ops.get(0).otherParams.get(0).comma();
  }

  @Test
  void theApisIncludeListsAreCommaLists() {
    OperationPlanner ops = Generator.plan(Generator.read(API)).operations();
    List<String> comma =
        ops.ops.stream()
            .flatMap(op -> op.otherParams.stream().filter(OperationPlanner.OtherParam::comma).map(p -> op.id + " " + p.wire()))
            .sorted()
            .toList();
    assertThat(comma)
        .containsExactly(
            "agents.testSet.listCases include",
            "cost.records.get include",
            "cost.records.list include",
            "identity.users.list include",
            "runs.list include");
  }

  @Test
  void formWithExplodeFalseIsACommaList() {
    assertThat(comma(plan(include("query", ARRAY, "style", "form", "explode", false)))).isTrue();
    assertThat(comma(plan(include("query", ARRAY, "explode", false)))).isTrue();
  }

  @Test
  void repeatedKeysStayTheDefault() {
    assertThat(comma(plan(include("query", ARRAY)))).isFalse();
    assertThat(comma(plan(include("query", ARRAY, "style", "form")))).isFalse();
    assertThat(comma(plan(include("query", ARRAY, "style", "form", "explode", true)))).isFalse();
  }

  @Test
  void anotherStyleIsRefused() {
    assertThatThrownBy(() -> plan(include("query", ARRAY, "style", "pipeDelimited", "explode", false)))
        .isInstanceOf(GenerationException.class)
        .hasMessageContaining("has style pipeDelimited; only form is supported");
  }

  @Test
  void explodeFalseOnAValueIsRefused() {
    assertThatThrownBy(() -> plan(include("query", obj("type", "string"), "style", "form", "explode", false)))
        .isInstanceOf(GenerationException.class)
        .hasMessageContaining("has explode false but isn't an array");
  }

  @Test
  void styleOutsideTheQueryIsRefused() {
    assertThatThrownBy(() -> plan(include("header", ARRAY, "style", "form", "explode", false)))
        .isInstanceOf(GenerationException.class)
        .hasMessageContaining("sets style or explode outside the query");
  }

  @Test
  void anotherParameterKeyIsStillRefused() {
    assertThatThrownBy(() -> plan(include("query", ARRAY, "allowReserved", true)))
        .isInstanceOf(GenerationException.class)
        .hasMessageContaining("unsupported parameter key allowReserved");
  }
}
