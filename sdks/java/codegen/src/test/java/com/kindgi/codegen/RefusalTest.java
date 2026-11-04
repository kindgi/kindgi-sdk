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

  /** An object with one required string property, {@code prop}. */
  private static Map<String, Object> needs(String prop) {
    return obj("type", "object", "required", List.of(prop), "properties", Map.of(prop, obj("type", "string")));
  }

  /** An object whose required {@code kind} is {@code tag}, with a required {@code prop} beside it. */
  private static Map<String, Object> tagged(String tag, String prop) {
    return obj(
        "type", "object", "required", List.of("kind", prop),
        "properties", obj("kind", obj("type", "string", "const", tag), prop, obj("type", "string")));
  }

  private static Map<String, Object> ref(String name) {
    return Map.of("$ref", "#/components/schemas/" + name);
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

  /** An app's own Jackson reads a text-or-object union's objects by their properties only. */
  @Test
  void aTextBesideObjectsThatCarryATag() {
    refuses(
        Map.of("U", obj("oneOf", List.of(obj("type", "string"), tagged("a", "x"), tagged("b", "y")))),
        "com.kindgi.client.models.U: a text-or-object union whose objects carry a tag (kind)");
  }

  /** It reads as itself (no type info of its own), so it can't carry another union's. */
  @Test
  void anObjectOfATextOrObjectUnionThatsAVariantOfAnotherTypedUnion() {
    Map<String, Object> schemas = new LinkedHashMap<>();
    schemas.put("A", needs("a"));
    schemas.put("B", needs("b"));
    schemas.put("C", needs("c"));
    schemas.put("T", obj("oneOf", List.of(obj("type", "string"), ref("A"), ref("B"))));
    schemas.put("U", obj("oneOf", List.of(ref("A"), ref("C"))));
    refuses(
        schemas,
        "com.kindgi.client.models.A is an object of the text-or-object union com.kindgi.client.models.T and a"
            + " variant of com.kindgi.client.models.U");
  }

  @Test
  void aVariantOfTwoUnionsThatTellTheirVariantsApartDifferently() {
    Map<String, Object> schemas = new LinkedHashMap<>();
    schemas.put("A", tagged("a", "x"));
    schemas.put("B", tagged("b", "y"));
    schemas.put("C", needs("c"));
    schemas.put("ByKind", obj("oneOf", List.of(ref("A"), ref("B"))));
    schemas.put("ByProperties", obj("oneOf", List.of(ref("A"), ref("C"))));
    refuses(
        schemas,
        "com.kindgi.client.models.A is a variant of com.kindgi.client.models.ByKind and"
            + " com.kindgi.client.models.ByProperties, which tell their variants apart differently (by kind; by"
            + " their properties)");
  }

  @Test
  void anAnswerByStatusWhoseShapesCantBeToldApart() {
    Map<String, Object> schemas = new LinkedHashMap<>();
    schemas.put("A", needs("id"));
    schemas.put("B", obj("type", "object", "required", List.of("id"), "properties", obj("id", obj("type", "string"), "note", obj("type", "string"))));
    Map<String, Object> op =
        obj(
            "operationId", "a.make", "summary", "s", "tags", List.of(), "security", List.of(),
            "responses", obj("200", answer("A"), "202", answer("B")));
    assertThatThrownBy(() -> Generator.sources(doc(schemas, Map.of("/a", Map.of("post", op)))))
        .isInstanceOf(GenerationException.class)
        .hasMessageContaining("can't tell this answer's shapes apart");
  }

  private static Map<String, Object> answer(String schema) {
    return obj("description", "d", "content", Map.of("application/json", Map.of("schema", ref(schema))));
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
