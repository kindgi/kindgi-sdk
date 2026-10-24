// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * What the validator refuses as the runtime's strict compile refuses it: a keyword with no type it
 * applies to, a type its context can't be, a {@code required} property nothing defines, an empty
 * {@code enum}, and references that only come back to themselves.
 */
class SchemaValidatorStrictTest {
  /** The strict-schema test vectors (packages/specs/test-vectors/README.md). */
  private static final Path VECTORS = Path.of("../../../packages/specs/test-vectors/strict-schemas");

  @SuppressWarnings("unchecked")
  private static Map<String, Object> schema(String json) {
    try {
      return (Map<String, Object>) Json.parse(json.getBytes(StandardCharsets.UTF_8));
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  private static void refused(String json, String message) {
    assertThatThrownBy(() -> new SchemaValidator(schema(json)))
        .isInstanceOf(SchemaValidator.SchemaException.class)
        .hasMessage(message);
  }

  private static void compiles(String json) {
    assertThatCode(() -> new SchemaValidator(schema(json))).doesNotThrowAnyException();
  }

  @Test
  void aKeywordNeedsATypeItAppliesTo() {
    refused("{\"minLength\": 1}", "#: missing type \"string\" for keyword \"minLength\"");
    refused("{\"type\": \"string\", \"properties\": {}}", "#: missing type \"object\" for keyword \"properties\"");
    refused("{\"type\": \"boolean\", \"format\": \"date\"}", "#: missing type \"number,string\" for keyword \"format\"");
    refused(
        "{\"type\": \"object\", \"properties\": {\"a\": {\"items\": {}}}}",
        "#/properties/a: missing type \"array\" for keyword \"items\"");
    // A number keyword applies to an integer; a union needs one type the keyword applies to.
    compiles("{\"type\": \"integer\", \"minimum\": 0, \"format\": \"date\"}");
    compiles("{\"type\": [\"string\", \"null\"], \"minLength\": 1}");
    refused("{\"type\": [\"object\", \"null\"], \"minLength\": 1}", "#: missing type \"string\" for keyword \"minLength\"");
  }

  @Test
  void aSubschemaOnTheSameDataHasItsTypes() {
    compiles("{\"type\": \"string\", \"allOf\": [{\"minLength\": 1}], \"not\": {\"maxLength\": 0}}");
    compiles("{\"type\": \"object\", \"propertyNames\": {\"pattern\": \"^a\"}}");
    // Another data's schema starts afresh.
    refused("{\"type\": \"array\", \"items\": {\"minLength\": 1}}", "#/items: missing type \"string\" for keyword \"minLength\"");
    refused("{\"anyOf\": [{\"minLength\": 1}]}", "#/anyOf/0: missing type \"string\" for keyword \"minLength\"");
  }

  @Test
  void aTypeMustFitItsContext() {
    refused(
        "{\"type\": \"integer\", \"anyOf\": [{\"type\": \"number\"}]}",
        "#/anyOf/0/type: type \"number\" not allowed by context \"integer\"");
    compiles("{\"type\": \"number\", \"anyOf\": [{\"type\": \"integer\"}]}");
    // An integer narrows a number context.
    refused(
        "{\"type\": \"number\", \"allOf\": [{\"type\": \"integer\", \"allOf\": [{\"type\": \"number\"}]}]}",
        "#/allOf/0/allOf/0/type: type \"number\" not allowed by context \"integer\"");
  }

  @Test
  void aRequiredPropertyMustBeDefined() {
    refused("{\"type\": \"object\", \"required\": [\"a\"]}", "#/required: required property \"a\" is not defined");
    compiles("{\"type\": \"object\", \"required\": [\"a\"], \"properties\": {\"a\": {}}}");
    // By a schema compiled before it on the same data: an allOf member is, its parent's
    // properties aren't.
    compiles("{\"type\": \"object\", \"allOf\": [{\"properties\": {\"a\": {}}}], \"required\": [\"a\"]}");
    refused(
        "{\"type\": \"object\", \"properties\": {\"a\": {}}, \"allOf\": [{\"required\": [\"a\"]}]}",
        "#/allOf/0/required: required property \"a\" is not defined");
    // The runtime finds the names every JavaScript object has on any properties.
    compiles("{\"type\": \"object\", \"properties\": {}, \"required\": [\"toString\"]}");
    refused("{\"type\": \"object\", \"required\": [\"toString\"]}", "#/required: required property \"toString\" is not defined");
  }

  @Test
  void anEnumNeedsAValue() {
    refused("{\"enum\": []}", "#/enum: enum must have non-empty array");
  }

  @Test
  void aReferenceTargetCompilesOnItsOwn() {
    refused(
        "{\"type\": \"string\", \"allOf\": [{\"$ref\": \"#/$defs/a\"}], \"$defs\": {\"a\": {\"minLength\": 1}}}",
        "#/$defs/a: missing type \"string\" for keyword \"minLength\"");
    compiles("{\"type\": \"object\", \"properties\": {\"child\": {\"$ref\": \"#\"}}}");
    refused(
        "{\"$ref\": \"#/$defs/a\", \"$defs\": {\"a\": {\"$ref\": \"#/$defs/b\"}, \"b\": {\"$ref\": \"#/$defs/a\"}}}",
        "#/$ref: #/$defs/a comes back to itself through references alone");
  }

  @Test
  void nullableIsNotAKeywordItTakes() {
    refused("{\"type\": \"string\", \"nullable\": true}", "#: unknown keyword \"nullable\"");
  }

  @Test
  @SuppressWarnings("unchecked")
  void everyVectorItCanCheckGetsTheRuntimesVerdict() throws IOException {
    Map<String, Object> corpus = (Map<String, Object>) Json.parse(Files.readAllBytes(VECTORS.resolve("corpus.json")));
    Map<String, Object> answers = (Map<String, Object>) Json.parse(Files.readAllBytes(VECTORS.resolve("answers.json")));
    Map<String, Object> cases = (Map<String, Object>) corpus.get("parity");
    Map<String, Object> said = (Map<String, Object>) answers.get("parity");
    List<String> mismatches = new ArrayList<>();
    int checked = 0;
    for (Map.Entry<String, Object> c : cases.entrySet()) {
      String refusal = null;
      try {
        new SchemaValidator((Map<String, Object>) c.getValue());
      } catch (SchemaValidator.SchemaException e) {
        refusal = e.getMessage();
      }
      // A keyword, a format or a reference this validator doesn't take: no verdict to compare.
      if (refusal != null && refusal.matches(".*(unknown keyword|unknown format|only local references|unsupported reference|not a regular expression).*")) {
        continue;
      }
      checked++;
      Object runtime = said.get(c.getKey());
      if ((refusal == null) != (runtime == null)) {
        mismatches.add(c.getKey() + "\n   runtime " + runtime + "\n   java    " + refusal);
      }
    }
    assertThat(checked).isGreaterThan(50);
    assertThat(mismatches).isEmpty();
  }
}
