// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.codegen;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * A deprecated operation's methods are {@code @Deprecated}, with its description's first paragraph
 * (what to use instead) as their {@code @deprecated} tag.
 */
class DeprecatedTest {
  private static Map<String, Object> obj(Object... kv) {
    Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i < kv.length; i += 2) {
      m.put((String) kv[i], kv[i + 1]);
    }
    return m;
  }

  /** {@code widgets.list}, deprecated with {@code description} (or none), beside {@code gadgets.list}. */
  private static Map<String, Object> doc(String description) {
    Map<String, Object> listed = obj("204", obj("description", "Listed."));
    Map<String, Object> widgets = obj("operationId", "widgets.list", "deprecated", true, "responses", listed);
    if (description != null) {
      widgets.put("description", description);
    }
    Map<String, Object> d = new LinkedHashMap<>();
    d.put("openapi", "3.1.0");
    d.put("info", Map.of("title", "t", "version", "1"));
    d.put(
        "paths",
        obj(
            "/v1/widgets", obj("get", widgets),
            "/v1/gadgets", obj("get", obj("operationId", "gadgets.list", "responses", listed))));
    d.put("components", Map.of("schemas", Map.of()));
    return d;
  }

  /** {@code widgets.list}, deprecated and cursor-paginated, so its sync resource reads every page too. */
  private static Map<String, Object> pagedDoc() {
    Map<String, Object> cursor =
        obj("name", "cursor", "in", "query", "required", false, "schema", obj("type", "string"));
    Map<String, Object> page =
        obj(
            "200",
            obj(
                "description",
                "A page.",
                "content",
                obj("application/json", obj("schema", obj("$ref", "#/components/schemas/WidgetPage")))));
    Map<String, Object> widgets =
        obj(
            "operationId", "widgets.list",
            "deprecated", true,
            "description", "Use `gadgets.list`. Removed in 2.0.0.",
            "parameters", List.of(cursor),
            "responses", page);
    Map<String, Object> d = new LinkedHashMap<>();
    d.put("openapi", "3.1.0");
    d.put("info", Map.of("title", "t", "version", "1"));
    d.put("paths", obj("/v1/widgets", obj("get", widgets)));
    d.put(
        "components",
        obj(
            "schemas",
            obj(
                "Widget",
                obj("type", "object", "required", List.of("id"), "properties", obj("id", obj("type", "string"))),
                "WidgetPage",
                obj(
                    "type", "object",
                    "required", List.of("data", "hasMore"),
                    "properties",
                        obj(
                            "data", obj("type", "array", "items", obj("$ref", "#/components/schemas/Widget")),
                            "hasMore", obj("type", "boolean"),
                            "nextCursor", obj("type", "string"))))));
    return d;
  }

  /** Each {@code public} declaration of {@code name(…)} in {@code source}, and how many are {@code @Deprecated}. */
  private static int[] declared(String source, String name) {
    String decl = "public [^\\n(]*\\b" + name + "\\(";
    return new int[] {
      Pattern.compile(decl).matcher(source).results().toList().size(),
      Pattern.compile("@Deprecated\\n\\s*" + decl).matcher(source).results().toList().size()
    };
  }

  private static String resource(Map<String, Object> doc, String name) {
    return Generator.sources(doc).files().get("com/kindgi/client/resources/" + name + ".java");
  }

  @Test
  void aDeprecatedOperationsMethodsSayWhatToUseInstead() {
    Map<String, Object> d = doc("Use `gadgets.list`.\nRemoved in 2.0.0.\n\nLists widgets.");
    for (String name : List.of("WidgetsResource", "AsyncWidgetsResource")) {
      String source = resource(d, name);
      assertThat(source)
          .as(name)
          .containsOnlyOnce("@Deprecated")
          .containsPattern(
              "\\* @deprecated Use <code>gadgets\\.list</code>\\. Removed in 2\\.0\\.0\\.\\n\\s*\\*/\\n\\s*@Deprecated\\n\\s*public ");
    }
  }

  @Test
  void aDeprecatedPagedOperationsEveryPageMethodsAreDeprecatedToo() {
    Map<String, Object> d = pagedDoc();
    String sync = resource(d, "WidgetsResource");
    for (String name : List.of("list", "listAll")) {
      int[] n = declared(sync, name);
      assertThat(n[0]).as("WidgetsResource." + name).isPositive();
      assertThat(n[1]).as("WidgetsResource." + name + " @Deprecated").isEqualTo(n[0]);
    }
    assertThat(sync).contains("@deprecated Use <code>gadgets.list</code>. Removed in 2.0.0.");
    String async = resource(d, "AsyncWidgetsResource");
    int[] n = declared(async, "list");
    assertThat(n[0]).as("AsyncWidgetsResource.list").isPositive();
    assertThat(n[1]).as("AsyncWidgetsResource.list @Deprecated").isEqualTo(n[0]);
  }

  @Test
  void anOperationNotDeprecatedIsAsItWas() {
    Map<String, Object> d = doc("Use `gadgets.list`. Removed in 2.0.0.");
    for (String name : List.of("GadgetsResource", "AsyncGadgetsResource")) {
      assertThat(resource(d, name)).as(name).doesNotContainIgnoringCase("deprecated");
    }
  }

  @Test
  void aDeprecatedOperationWithNoNoteIsRefused() {
    for (String description : Arrays.asList(null, "", " \n ")) {
      assertThatThrownBy(() -> Generator.sources(doc(description)))
          .as(String.valueOf(description))
          .isInstanceOf(GenerationException.class)
          .hasMessageContaining(
              "widgets.list is deprecated, and its description doesn't open with what to use instead");
    }
  }
}
