// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.kindgi.pack.http.HttpAuthSpec;
import com.kindgi.pack.http.HttpMethod;
import com.kindgi.pack.http.HttpRequestBodySpec;
import com.kindgi.pack.http.HttpToolSpec;
import com.kindgi.pack.http.ToolSecretRef;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Mirrors the Python {@code test_http_tool.py}: an HTTP tool declared as data — the spec it emits
 * into the pack index, the specs it refuses, and that calling it in-process throws (only the
 * runtime makes the request). Cases Python checks by passing an invalid {@code method}, {@code
 * authorization.kind} or {@code requestBody.kind} aren't here: the Java types (an enum method,
 * sealed auth and body) make those unrepresentable at compile time.
 */
final class HttpToolTest {

  record CaseLookup(String court, String docket) {}

  record Found(String title) {}

  @SuppressWarnings("unchecked")
  private static Map<String, Object> specOf(Tool<?, ?> tool) {
    return (Map<String, Object>) tool.extra().get("spec");
  }

  private static Tool.Builder<CaseLookup, Found> lookup() {
    return Tool.define("acme.lookup")
        .description("Look up a case.")
        .input(CaseLookup.class)
        .output(Found.class);
  }

  @Test
  void emitsTheFullSpec() {
    Tool<CaseLookup, Found> tool =
        lookup()
            .version("1.0.0")
            .http(
                HttpToolSpec.builder()
                    .method(HttpMethod.GET)
                    .urlTemplate("https://cases.example.com/{court}/{docket}")
                    .header("accept", "application/json")
                    .authorization(new HttpAuthSpec.Bearer(new ToolSecretRef("local", "ACME_TOKEN")))
                    .timeoutMs(5000)
                    .successStatus(200, 299)
                    .build());

    Map<String, Object> spec = specOf(tool);
    assertEquals("http", spec.get("kind"));
    assertEquals("GET", spec.get("method"));
    assertEquals("https://cases.example.com/{court}/{docket}", spec.get("urlTemplate"));
    assertEquals(List.of(Map.of("name", "accept", "value", "application/json")), spec.get("headers"));
    assertEquals(
        Map.of("kind", "bearer", "secretRef", Map.of("envName", "local", "name", "ACME_TOKEN")),
        spec.get("authorization"));
    assertEquals(Integer.valueOf(5000), spec.get("timeoutMs"));
    assertEquals(Map.of("min", 200, "max", 299), spec.get("successStatus"));
  }

  @Test
  void emitsOnlyTheGivenFields() {
    Tool<CaseLookup, Found> tool =
        lookup()
            .http(
                HttpToolSpec.builder()
                    .method(HttpMethod.POST)
                    .urlTemplate("https://cases.example.com/{court}/{docket}")
                    .build());

    assertEquals(Set.of("kind", "method", "urlTemplate"), specOf(tool).keySet());
  }

  @Test
  void emitsARequestBodyAndParseJson() {
    Tool<CaseLookup, Found> tool =
        lookup()
            .http(
                HttpToolSpec.builder()
                    .method(HttpMethod.POST)
                    .urlTemplate("https://cases.example.com/{court}/{docket}")
                    .requestBody(new HttpRequestBodySpec.JsonInput())
                    .parseJson(false)
                    .build());

    Map<String, Object> spec = specOf(tool);
    assertEquals(Map.of("kind", "json-input"), spec.get("requestBody"));
    assertEquals(Boolean.FALSE, spec.get("parseJson"));
  }

  @Test
  void anEmptyUrlTemplateIsRefusedBySchema() {
    IllegalArgumentException e =
        assertThrows(
            IllegalArgumentException.class,
            () ->
                lookup()
                    .http(HttpToolSpec.builder().method(HttpMethod.GET).urlTemplate("").build()));
    assertTrue(e.getMessage().contains("not a valid HTTP tool spec"));
    assertTrue(e.getMessage().contains("urlTemplate"));
  }

  @Test
  void aZeroTimeoutIsRefusedBySchema() {
    IllegalArgumentException e =
        assertThrows(
            IllegalArgumentException.class,
            () ->
                lookup()
                    .http(
                        HttpToolSpec.builder()
                            .method(HttpMethod.GET)
                            .urlTemplate("https://cases.example.com/{court}/{docket}")
                            .timeoutMs(0)
                            .build()));
    assertTrue(e.getMessage().contains("not a valid HTTP tool spec"));
    assertTrue(e.getMessage().contains("timeoutMs"));
  }

  @Test
  void aSuccessStatusBelowTheMinimumIsRefusedBySchema() {
    IllegalArgumentException e =
        assertThrows(
            IllegalArgumentException.class,
            () ->
                lookup()
                    .http(
                        HttpToolSpec.builder()
                            .method(HttpMethod.GET)
                            .urlTemplate("https://cases.example.com/{court}/{docket}")
                            .successStatus(99, 299)
                            .build()));
    assertTrue(e.getMessage().contains("not a valid HTTP tool spec"));
    assertTrue(e.getMessage().contains("successStatus"));
  }

  @Test
  void aConnectionAuthorizationNamesTheConnection() {
    Tool<CaseLookup, Found> tool =
        lookup()
            .http(
                HttpToolSpec.builder()
                    .method(HttpMethod.GET)
                    .urlTemplate("https://cases.example.com/{court}/{docket}")
                    .authorization(new HttpAuthSpec.Connection("cases"))
                    .build());
    assertEquals(Map.of("kind", "connection", "connection", "cases"), specOf(tool).get("authorization"));
  }

  @Test
  void aSecretRefWithoutAnEnvNameIsRefusedBySchema() {
    IllegalArgumentException e =
        assertThrows(
            IllegalArgumentException.class,
            () ->
                lookup()
                    .http(
                        HttpToolSpec.builder()
                            .method(HttpMethod.GET)
                            .urlTemplate("https://cases.example.com/{court}/{docket}")
                            .authorization(new HttpAuthSpec.Bearer(new ToolSecretRef("", "ACME_TOKEN")))
                            .build()));
    assertTrue(e.getMessage().contains("not a valid HTTP tool spec"));
    assertTrue(e.getMessage().contains("authorization"));
  }

  @Test
  void urlPlaceholdersMustBeInputFields() {
    IllegalArgumentException e =
        assertThrows(
            IllegalArgumentException.class,
            () ->
                lookup()
                    .http(
                        HttpToolSpec.builder()
                            .method(HttpMethod.GET)
                            .urlTemplate("https://cases.example.com/{region}/{year}")
                            .build()));
    assertTrue(
        e.getMessage().contains("{region}, {year} not a field of the input, which fills placeholders"),
        e.getMessage());
  }

  @Test
  void aTextBodyPlaceholderMustBeAnInputField() {
    IllegalArgumentException e =
        assertThrows(
            IllegalArgumentException.class,
            () ->
                lookup()
                    .http(
                        HttpToolSpec.builder()
                            .method(HttpMethod.POST)
                            .urlTemplate("https://cases.example.com/{court}")
                            .requestBody(new HttpRequestBodySpec.Text("case {docket} by {judge}"))
                            .build()));
    assertTrue(
        e.getMessage().contains("{judge} not a field of the input, which fills placeholders"),
        e.getMessage());
  }

  @Test
  void knownPlaceholdersInTheUrlAndTextBodyAreFine() {
    Tool<CaseLookup, Found> tool =
        lookup()
            .http(
                HttpToolSpec.builder()
                    .method(HttpMethod.POST)
                    .urlTemplate("https://cases.example.com/{court}/{docket}")
                    .requestBody(new HttpRequestBodySpec.Text("case {docket}"))
                    .build());
    assertEquals("text", ((Map<?, ?>) specOf(tool).get("requestBody")).get("kind"));
  }

  @Test
  void aBraceInTheUrlThatIsntAPlaceholdersIsRefused() {
    for (String url :
        List.of(
            "https://cases.example.com/{court}/{{docket}}",
            "https://cases.example.com/{court}/{docket}{?q}",
            "https://cases.example.com/{court}/{docket-id}",
            "https://cases.example.com/{court}/{docket",
            "https://cases.example.com/{court}/{größe}")) {
      IllegalArgumentException e =
          assertThrows(
              IllegalArgumentException.class,
              () ->
                  lookup()
                      .http(
                          HttpToolSpec.builder().method(HttpMethod.GET).urlTemplate(url).build()),
              url);
      assertEquals(
          "Tool \"acme.lookup\" spec.urlTemplate has a brace that isn't part of a {field}"
              + " placeholder; write a literal one as %7B or %7D",
          e.getMessage());
    }
    lookup()
        .http(
            HttpToolSpec.builder()
                .method(HttpMethod.GET)
                .urlTemplate("https://cases.example.com/{court}/{docket}?f=%7Bopen%7D")
                .build());
  }

  @Test
  void aNameThatIsntAsciiInATextBodyOrAHeaderIsRefused() {
    IllegalArgumentException body =
        assertThrows(
            IllegalArgumentException.class,
            () ->
                lookup()
                    .http(
                        HttpToolSpec.builder()
                            .method(HttpMethod.POST)
                            .urlTemplate("https://cases.example.com/{court}")
                            .requestBody(new HttpRequestBodySpec.Text("{\"size\": \"{größe}\"}"))
                            .build()));
    assertEquals(
        "Tool \"acme.lookup\" spec.requestBody.template has {größe}, which isn't a {field}"
            + " placeholder: a placeholder's name is ASCII letters, digits and _",
        body.getMessage());
    IllegalArgumentException header =
        assertThrows(
            IllegalArgumentException.class,
            () ->
                lookup()
                    .http(
                        HttpToolSpec.builder()
                            .method(HttpMethod.GET)
                            .urlTemplate("https://cases.example.com/{court}")
                            .header("Accept", "application/json")
                            .header("X-Query", "{größe} {straße}")
                            .build()));
    assertEquals(
        "Tool \"acme.lookup\" spec.headers[1].value (the header \"X-Query\") has {größe},"
            + " {straße}, which aren't {field} placeholders: a placeholder's name is ASCII"
            + " letters, digits and _",
        header.getMessage());
  }

  @Test
  void jsonAndGraphqlWithSpacesInsideItsBracesPass() {
    lookup()
        .http(
            HttpToolSpec.builder()
                .method(HttpMethod.POST)
                .urlTemplate("https://cases.example.com/{court}")
                .header("X-Filter", "{\"docket\": \"{docket}\"}")
                .requestBody(
                    new HttpRequestBodySpec.Text("query { case(docket: \"{docket}\") { title } }"))
                .build());
  }

  @Test
  void aPlaceholderInTheHostIsRefused() {
    IllegalArgumentException e =
        assertThrows(
            IllegalArgumentException.class,
            () ->
                lookup()
                    .http(
                        HttpToolSpec.builder()
                            .method(HttpMethod.GET)
                            .urlTemplate("https://{tenant}.example.com/{court}/{docket}")
                            .build()));
    assertTrue(
        e.getMessage().contains("in its path and query only, never in its host or port"),
        e.getMessage());
  }

  @Test
  void aUrlWithoutASchemeIsRefused() {
    IllegalArgumentException e =
        assertThrows(
            IllegalArgumentException.class,
            () ->
                lookup()
                    .http(
                        HttpToolSpec.builder()
                            .method(HttpMethod.GET)
                            .urlTemplate("cases.example.com/{court}/{docket}")
                            .build()));
    assertTrue(
        e.getMessage().contains("must start with http:// or https:// and a host"), e.getMessage());
  }

  @Test
  void aUrlWithoutAHostIsRefused() {
    IllegalArgumentException e =
        assertThrows(
            IllegalArgumentException.class,
            () ->
                lookup()
                    .http(
                        HttpToolSpec.builder()
                            .method(HttpMethod.GET)
                            .urlTemplate("https:///{court}/{docket}")
                            .build()));
    assertTrue(e.getMessage().contains("must name a host"), e.getMessage());
  }

  @Test
  void callingAnHttpToolInProcessThrows() {
    Tool<CaseLookup, Found> tool =
        lookup()
            .http(
                HttpToolSpec.builder()
                    .method(HttpMethod.GET)
                    .urlTemplate("https://cases.example.com/{court}/{docket}")
                    .build());

    UnsupportedOperationException e =
        assertThrows(
            UnsupportedOperationException.class,
            () -> tool.call(new CaseLookup("ca", "123"), ToolContext.forTest()));
    assertTrue(e.getMessage().contains("the Kindgi runtime makes its request"), e.getMessage());
  }

  @Test
  void theSpecLandsAsTheToolsSpecEntry() {
    Tool<CaseLookup, Found> tool =
        lookup()
            .http(
                HttpToolSpec.builder()
                    .method(HttpMethod.GET)
                    .urlTemplate("https://cases.example.com/{court}/{docket}")
                    .build());
    assertFalse(specOf(tool).isEmpty());
    assertEquals("http", specOf(tool).get("kind"));
  }

  @Test
  void aRepeatedHeaderNameIsRefusedIgnoringCase() {
    IllegalArgumentException e =
        assertThrows(
            IllegalArgumentException.class,
            () ->
                HttpToolSpec.builder()
                    .method(HttpMethod.GET)
                    .urlTemplate("https://cases.example.com/{court}/{docket}")
                    .header("Accept", "application/json")
                    .header("accept", "text/plain"));
    assertTrue(e.getMessage().contains("was already set"), e.getMessage());
  }

  @Test
  void theSpecDoesNotLeakToALaterToolBuiltFromTheSameBuilder() {
    Tool.Builder<CaseLookup, Found> builder = lookup();
    builder.http(
        HttpToolSpec.builder()
            .method(HttpMethod.GET)
            .urlTemplate("https://cases.example.com/{court}/{docket}")
            .build());

    // The same builder, now given a handler: it must not carry the HTTP tool's `spec`.
    Tool<CaseLookup, Found> handled = builder.handler((input, ctx) -> new Found(input.docket()));
    assertFalse(handled.extra().containsKey("spec"));
  }
}
