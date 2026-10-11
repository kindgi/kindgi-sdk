// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.codegen;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The generator refuses what it doesn't support, so a new spec feature can't mis-generate. */
class RefusalTest {
  private static Map<String, Object> doc(Map<String, Object> schemas, Map<String, Object> paths) {
    Map<String, Object> d = new LinkedHashMap<>();
    d.put("openapi", "3.1.0");
    d.put("info", Map.of("title", "t", "version", "1"));
    d.put("paths", paths);
    d.put("components", Map.of("schemas", schemas));
    return d;
  }

  private static Map<String, Object> obj(Object... kv) {
    Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i < kv.length; i += 2) {
      m.put((String) kv[i], kv[i + 1]);
    }
    return m;
  }

  private static void refuses(Map<String, Object> schemas, String message) {
    assertThatThrownBy(() -> Generator.sources(doc(schemas, Map.of()))).isInstanceOf(GenerationException.class).hasMessageContaining(message);
  }

  @Test
  void anUnknownKeyword() {
    refuses(Map.of("A", obj("type", "object", "properties", Map.of("x", obj("type", "string", "not", Map.of())))), "unsupported schema keyword \"not\"");
  }

  @Test
  void anUnknownFormat() {
    refuses(Map.of("A", obj("type", "string", "format", "email")), "unsupported format \"email\"");
  }

  @Test
  void aUnionWhoseVariantsCantBeToldApart() {
    Map<String, Object> v = obj("type", "object", "required", List.of("a"), "properties", Map.of("a", obj("type", "string")));
    refuses(Map.of("U", obj("oneOf", List.of(v, v))), "can't tell this union's variants apart");
  }

  @Test
  void twoTextVariantsBesideObjects() {
    Map<String, Object> o = obj("type", "object", "required", List.of("a"), "properties", Map.of("a", obj("type", "string")));
    refuses(
        Map.of("U", obj("oneOf", List.of(obj("type", "string", "enum", List.of("x")), obj("type", "string", "enum", List.of("y")), o))),
        "two text variants");
  }

  @Test
  void aNumberBesideObjects() {
    Map<String, Object> o = obj("type", "object", "required", List.of("a"), "properties", Map.of("a", obj("type", "string")));
    refuses(Map.of("U", obj("oneOf", List.of(obj("type", "number"), o))), "unsupported union variant");
  }

  @Test
  void enumValuesThatMakeTheSameConstant() {
    refuses(Map.of("E", obj("type", "string", "enum", List.of("a-b", "a_b"))), "duplicate constant A_B");
  }

  @Test
  void propertiesThatMakeTheSameJavaName() {
    refuses(
        Map.of("A", obj("type", "object", "properties", obj("foo_bar", obj("type", "string"), "fooBar", obj("type", "string")))),
        "two properties become the Java name fooBar");
  }

  @Test
  void aDiscriminatorThatDisagreesWithTheVariants() {
    Map<String, Object> a = obj("type", "object", "required", List.of("kind"), "properties", Map.of("kind", obj("type", "string", "const", "a")));
    Map<String, Object> b = obj("type", "object", "required", List.of("kind"), "properties", Map.of("kind", obj("type", "string", "const", "b")));
    Map<String, Object> schemas = new LinkedHashMap<>();
    schemas.put("A", a);
    schemas.put("B", b);
    schemas.put(
        "U",
        obj(
            "oneOf", List.of(Map.of("$ref", "#/components/schemas/A"), Map.of("$ref", "#/components/schemas/B")),
            "discriminator", obj("propertyName", "kind", "mapping", Map.of("a", "#/components/schemas/B"))));
    refuses(schemas, "disagrees with the variants' tags");
  }

  @Test
  void aMissingRef() {
    refuses(Map.of("A", obj("type", "object", "properties", Map.of("x", Map.of("$ref", "#/components/schemas/Nope")))), "missing schema: Nope");
  }

  @Test
  void anOperationWithAnUnsupportedMediaType() {
    Map<String, Object> op =
        obj(
            "operationId", "a.get", "summary", "s", "tags", List.of(), "security", List.of(),
            "responses", Map.of("200", obj("description", "d", "content", Map.of("text/csv", Map.of("schema", obj("type", "string"))))));
    assertThatThrownBy(() -> Generator.sources(doc(Map.of(), Map.of("/a", Map.of("get", op)))))
        .isInstanceOf(GenerationException.class)
        .hasMessageContaining("unsupported response media type text/csv");
  }

  @Test
  void pathLevelParameters() {
    Map<String, Object> op = obj("operationId", "a.get", "summary", "s", "tags", List.of(), "security", List.of(), "responses", Map.of());
    assertThatThrownBy(() -> Generator.sources(doc(Map.of(), Map.of("/a", obj("parameters", List.of(), "get", op)))))
        .isInstanceOf(GenerationException.class)
        .hasMessageContaining("path-level parameters");
  }

  @Test
  void anOpenApi30Document() {
    Map<String, Object> d = doc(Map.of(), Map.of());
    d.put("openapi", "3.0.3");
    assertThatThrownBy(() -> {
          java.nio.file.Path f = java.nio.file.Files.createTempFile("openapi", ".json");
          java.nio.file.Files.writeString(f, tools.jackson.databind.json.JsonMapper.builder().build().writeValueAsString(d));
          Generator.read(f);
        })
        .isInstanceOf(GenerationException.class)
        .hasMessageContaining("only OpenAPI 3.1");
  }
}
