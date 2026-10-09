// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The validator against Ajv, the referee the TypeScript pack service trusts: every value of the
 * corpus ({@code ajv/corpus.json}, some against derived schemas from {@code derive/golden.json})
 * gets Ajv's verdict and Ajv's issues ({@code ajv/oracle.json}, written by {@code
 * scripts/ajv-oracle.mjs}), in any order.
 */
class AjvOracleTest {
  @SuppressWarnings("unchecked")
  private static Map<String, Object> resource(String name) throws IOException {
    try (InputStream in = AjvOracleTest.class.getResourceAsStream("/" + name)) {
      return (Map<String, Object>) Json.parse(in.readAllBytes());
    }
  }

  @Test
  @SuppressWarnings("unchecked")
  void everyVerdictAndIssueIsAjvs() throws IOException {
    List<Map<String, Object>> corpus = (List<Map<String, Object>>) resource("ajv/corpus.json").get("cases");
    List<Map<String, Object>> oracle = (List<Map<String, Object>>) resource("ajv/oracle.json").get("cases");
    Map<String, Object> derived = resource("derive/golden.json");
    List<String> mismatches = new ArrayList<>();
    int checked = 0;
    for (Map<String, Object> expected : oracle) {
      Map<String, Object> entry =
          corpus.stream().filter(c -> c.get("name").equals(expected.get("name"))).findFirst().orElseThrow();
      Object schema = entry.containsKey("schemaFrom") ? derived.get(entry.get("schemaFrom")) : entry.get("schema");
      SchemaValidator validator = new SchemaValidator((Map<String, Object>) schema);
      Object value = ((List<Object>) entry.get("values")).get(((Number) expected.get("value")).intValue());
      List<Map<String, Object>> issues = validator.issues(value);
      List<String> got = canonical(issues);
      List<String> want = canonical((List<Map<String, Object>>) expected.get("issues"));
      boolean validMatches = issues.isEmpty() == (Boolean) expected.get("valid");
      if (!validMatches || !got.equals(want)) {
        mismatches.add(expected.get("name") + " #" + expected.get("value") + " (" + Json.compactString(value) + ")\n   want " + want + "\n   got  " + got);
      }
      checked++;
    }
    assertThat(checked).isEqualTo(oracle.size()).isGreaterThan(50);
    assertThat(mismatches).isEmpty();
  }

  @Test
  @SuppressWarnings("unchecked")
  void canonicalJsonIsWhatJavaScriptWrites() throws IOException {
    List<Map<String, Object>> cases = (List<Map<String, Object>>) resource("ajv/oracle.json").get("canonical");
    List<String> mismatches = new ArrayList<>();
    for (Map<String, Object> c : cases) {
      Object value = Json.parse(((String) c.get("text")).getBytes(java.nio.charset.StandardCharsets.UTF_8));
      String got = CanonicalJson.stable(value);
      if (!got.equals(c.get("json"))) {
        mismatches.add(c.get("text") + ": want " + c.get("json") + ", got " + got);
      }
    }
    assertThat(cases).hasSizeGreaterThan(15);
    assertThat(mismatches).isEmpty();
  }

  private static List<String> canonical(List<Map<String, Object>> issues) {
    List<String> out = new ArrayList<>();
    for (Map<String, Object> issue : issues) {
      out.add(CanonicalJson.stable(issue).replaceAll("\\s+", " "));
    }
    out.sort(null);
    return out;
  }
}
