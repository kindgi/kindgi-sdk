// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.models;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import java.io.IOException;
import java.lang.reflect.Method;
import java.net.URISyntaxException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * An app's own Jackson 2 mapper reads and writes the models through their annotations, with the
 * API's wire names: the client's own codec isn't involved. The tests run with the Jackson that
 * {@code jackson2.test.version} names, and CI runs them with each line a Spring Boot release
 * manages, from 2.15 (Spring Boot 3.2's) on.
 */
class AppJacksonTest {
  private static final String UNKNOWN = "kindgi-test-unknown";

  private final ObjectMapper app =
      new ObjectMapper()
          .registerModule(new JavaTimeModule())
          .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
          .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
  private final ObjectMapper strict =
      new ObjectMapper()
          .registerModule(new JavaTimeModule())
          .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
          .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);

  @Test
  void writesWithWireNames() throws Exception {
    assertThat(app.writeValueAsString(StartRunBody.WithAgent.builder().agent("acme.bookkeeper").input(Map.of("userMessage", "hi")).build()))
        .isEqualTo("{\"agent\":\"acme.bookkeeper\",\"input\":{\"userMessage\":\"hi\"}}");
    assertThat(app.writeValueAsString(StartRunOptions.builder().wait_(true).build())).isEqualTo("{\"wait\":true}");
  }

  @Test
  void writesAnUpdatesExplicitNullAndLeavesOutAnAbsentProperty() throws Exception {
    assertThat(app.writeValueAsString(PatchScheduleBody.builder().label(null).build())).isEqualTo("{\"label\":null}");
    assertThat(app.writeValueAsString(PatchScheduleBody.builder().flowVersion("2").build())).isEqualTo("{\"flowVersion\":\"2\"}");
  }

  @Test
  void readsRecordsTaggedUnionsAndEnums() throws Exception {
    assertThat(app.readValue("{\"prompt\":\"acme.tone\",\"version\":\"^1.0.0\"}", PromptRef.class)).isEqualTo(new PromptRef("acme.tone", "^1.0.0"));
    assertThat(app.readValue("{\"kind\":\"tenant\"}", AgentPinScope.class)).isInstanceOf(PinScopeTenant.class);
    assertThat(app.readValue("{\"kind\":\"galaxy\",\"arm\":3}", AgentPinScope.class)).isInstanceOf(AgentPinScope.Unrecognized.class);
    assertThat(app.readValue("\"hibernating\"", Run.Status.class).value()).isEqualTo(Run.Status.Value.UNRECOGNIZED);
  }

  /**
   * A newer runtime's variant keeps every property, also one spelled like the record's own map
   * ({@code properties}) and one whose value is {@code null}, and writes them back; a strict mapper
   * reads it too. Maps are compared, not text: the order of an object's properties carries no
   * meaning.
   */
  @Test
  void everyTaggedOrDeducedUnionKeepsAVariantItDoesntKnow() throws Exception {
    Map<String, Object> others = new LinkedHashMap<>();
    others.put("kindgiTestExtra", 1);
    others.put("properties", Map.of("x", 1));
    others.put("kindgiTestNull", null);
    List<String> unions = new ArrayList<>();
    for (Class<?> type : models()) {
      JsonTypeInfo info = type.getAnnotation(JsonTypeInfo.class);
      if (info == null || !type.isInterface()) {
        continue;
      }
      Class<?> unrecognized = info.defaultImpl();
      Map<String, Object> body = new LinkedHashMap<>();
      if (info.use() == JsonTypeInfo.Id.NAME) {
        body.put(info.property(), UNKNOWN);
      }
      body.putAll(others);
      String json = app.writeValueAsString(body);
      for (ObjectMapper mapper : List.of(app, strict)) {
        Object read = mapper.readValue(json, type);
        assertThat(read).as(type.getName()).isInstanceOf(unrecognized);
        assertThat(unrecognized.getMethod("properties").invoke(read)).as(type.getName()).isEqualTo(others);
        assertThat(app.readValue(app.writeValueAsString(read), Map.class)).as(type.getName()).isEqualTo(body);
      }
      unions.add(type.getName());
    }
    assertThat(unions).contains(AgentPinScope.class.getName()).hasSizeGreaterThan(10);
  }

  /**
   * Every open record keeps each property it doesn't know, also one spelled like its own map
   * ({@code additionalProperties}) and one whose value is {@code null}, and writes them back; a
   * strict mapper reads it too.
   */
  @Test
  void everyOpenRecordKeepsEveryPropertyItDoesntKnow() throws Exception {
    Map<Class<?>, String> known = new LinkedHashMap<>();
    known.put(FactScope.class, "\"tenantId\":\"acme\"");
    known.put(FlowNode.class, "\"id\":\"n1\",\"kind\":\"tool\"");
    known.put(ProviderCost.class, "\"promptUsdPer1kTokens\":0.5,\"completionUsdPer1kTokens\":1.25");
    List<Class<?>> open = new ArrayList<>();
    for (Class<?> type : models()) {
      Method extras = type.isRecord() ? accessor(type, "additionalProperties") : null;
      if (extras != null && extras.isAnnotationPresent(JsonAnyGetter.class)) {
        open.add(type);
      }
    }
    assertThat(open).as("the open records this test reads").containsExactlyInAnyOrderElementsOf(known.keySet());
    Map<String, Object> others = new LinkedHashMap<>();
    others.put("kindgiTestExtra", 1);
    others.put("additionalProperties", Map.of("x", 1));
    others.put("kindgiTestNull", null);
    for (Map.Entry<Class<?>, String> e : known.entrySet()) {
      String json = "{" + e.getValue() + ",\"kindgiTestExtra\":1,\"additionalProperties\":{\"x\":1},\"kindgiTestNull\":null}";
      for (ObjectMapper mapper : List.of(app, strict)) {
        Object read = mapper.readValue(json, e.getKey());
        assertThat(e.getKey().getMethod("additionalProperties").invoke(read)).as(e.getKey().getName()).isEqualTo(others);
        assertThat(app.readValue(app.writeValueAsString(read), Map.class)).as(e.getKey().getName()).isEqualTo(app.readValue(json, Map.class));
      }
    }
  }

  @Test
  void aBuiltVariantWritesItsPropertiesAndHandsOutOnlyAView() throws Exception {
    AgentPinScope.Unrecognized built = new AgentPinScope.Unrecognized("galaxy", Map.of("arm", 3));
    assertThat(app.writeValueAsString(built)).isEqualTo("{\"kind\":\"galaxy\",\"arm\":3}");
    assertThat(app.readValue("{\"kind\":\"galaxy\",\"arm\":3}", AgentPinScope.class)).isEqualTo(built);
    assertThatThrownBy(() -> built.properties().put("y", 1)).isInstanceOf(UnsupportedOperationException.class);
    AgentPinScope.Unrecognized read = (AgentPinScope.Unrecognized) app.readValue("{\"kind\":\"galaxy\",\"arm\":3}", AgentPinScope.class);
    assertThatThrownBy(() -> read.properties().put("y", 1)).isInstanceOf(UnsupportedOperationException.class);
  }

  /** {@code type}'s public no-argument method {@code name}, if it has one. */
  private static Method accessor(Class<?> type, String name) {
    try {
      return type.getMethod(name);
    } catch (NoSuchMethodException e) {
      return null;
    }
  }

  /** Every class the models module generates, nested ones included. */
  private static List<Class<?>> models() throws IOException, URISyntaxException, ClassNotFoundException {
    Path location = Path.of(Model.class.getProtectionDomain().getCodeSource().getLocation().toURI());
    List<Class<?>> found = new ArrayList<>();
    List<String> names;
    try (Stream<Path> files = Files.list(location.resolve(Model.class.getPackageName().replace('.', '/')))) {
      names = files.map(f -> f.getFileName().toString()).filter(n -> n.endsWith(".class")).sorted().toList();
    }
    for (String name : names) {
      found.add(Class.forName(Model.class.getPackageName() + "." + name.substring(0, name.length() - ".class".length())));
    }
    return found;
  }
}
