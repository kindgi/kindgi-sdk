// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.models;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.deser.std.StdDeserializer;
import com.fasterxml.jackson.databind.exc.InvalidTypeIdException;
import com.fasterxml.jackson.databind.module.SimpleModule;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import java.io.IOException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
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
  private static final String PROJECT = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
  private static final String AGENT_ID = "{\"agentId\":\"acme.bookkeeper\",\"version\":\"1.0.0\"}";
  private static final String PINNED = "{\"pinned\":{\"projectId\":\"p1\"}}";
  private static final String PROMPT_REF = "{\"prompt\":\"acme.tone\",\"version\":\"^1.0.0\"}";
  private static final String ROTATED = "{\"kind\":\"sync\",\"newVersionId\":2,\"oldVersionId\":1}";
  private static final String UNKNOWN_OBJECT = "{\"galaxy\":3,\"arm\":\"x\"}";
  private static final Map<String, Object> UNKNOWN_PROPERTIES = Map.of("galaxy", 3, "arm", "x");
  private static final TestRunBaseline.WithAgentId BY_AGENT = new TestRunBaseline.WithAgentId("acme.bookkeeper", "1.0.0");
  private static final TestRunBaseline.WithPinned BY_PIN =
      new TestRunBaseline.WithPinned(new TestRunBaseline.WithPinned.Pinned("p1", null));

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
      // A by-status answer has nowhere to keep one: its shapes never grow.
      if (info == null || !type.isInterface() || info.defaultImpl() == JsonTypeInfo.class) {
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
        assertThat(app.readTree(app.writeValueAsString(read))).as(type.getName()).isEqualTo(app.readTree(json));
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
        assertThat(app.readTree(app.writeValueAsString(read))).as(e.getKey().getName()).isEqualTo(app.readTree(json));
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

  /**
   * Every union reads with an app's Jackson: it has type info, or (a text or an object) a
   * delegating creator. One with nowhere to keep a variant it doesn't know reads a listed sample,
   * so a new one fails here until it's listed. The objects of a text-or-object union get their
   * type info from a hidden interface, whose type info they don't take as their own.
   */
  @Test
  void everyUnionReadsWithAnAppsJackson() throws Exception {
    Map<Class<?>, String> samples = new LinkedHashMap<>();
    samples.put(AgentInstructions.class, PROMPT_REF);
    samples.put(SecretsRotateResponse.class, ROTATED);
    samples.put(TestRunBaseline.class, AGENT_ID);
    List<Class<?>> sampled = new ArrayList<>();
    List<Class<?>> objects = new ArrayList<>();
    for (Class<?> type : models()) {
      if (type.isInterface() && type.isSealed() && Model.class.isAssignableFrom(type)) {
        JsonTypeInfo info = type.getAnnotation(JsonTypeInfo.class);
        assertThat(info != null || delegatingCreator(type)).as(type.getName()).isTrue();
        if (info == null || info.defaultImpl() == JsonTypeInfo.class) {
          sampled.add(type);
        }
      }
      for (Class<?> hidden : type.getInterfaces()) {
        if (!Modifier.isPublic(hidden.getModifiers()) && hidden.isAnnotationPresent(JsonTypeInfo.class)) {
          JsonTypeInfo own = type.getAnnotation(JsonTypeInfo.class);
          assertThat(own != null && own.use() == JsonTypeInfo.Id.NONE).as(type.getName()).isTrue();
          objects.add(type);
        }
      }
    }
    assertThat(sampled).as("the unions read from a sample").containsExactlyInAnyOrderElementsOf(samples.keySet());
    assertThat(objects)
        .contains(TestRunBaseline.WithAgentId.class, TestRunBaseline.WithPinned.class, TestRunBaseline.Unrecognized.class);
    for (Map.Entry<Class<?>, String> e : samples.entrySet()) {
      for (ObjectMapper mapper : List.of(app, strict)) {
        assertThat(mapper.readValue(e.getValue(), e.getKey())).as(e.getKey().getName()).isInstanceOf(e.getKey());
      }
    }
  }

  /**
   * A test run's baseline is a text, or an object told apart by the properties it has. Each reads
   * as the client's own codec reads it: a newer text as text, a newer property left out, a newer
   * object kept as it came. Writes are the client's too.
   */
  @Test
  void readsAndWritesATextOrObjectUnion() throws Exception {
    assertThat(app.readValue("\"recorded\"", TestRunBaseline.class)).isEqualTo(TestRunBaseline.RECORDED);
    assertThat(app.readValue("\"galaxy\"", TestRunBaseline.class)).isEqualTo(TestRunBaseline.of("galaxy"));
    assertThat(app.readValue(AGENT_ID, TestRunBaseline.class)).isEqualTo(BY_AGENT);
    assertThat(app.readValue(withExtra(AGENT_ID), TestRunBaseline.class)).isEqualTo(BY_AGENT);
    assertThat(app.readValue(PINNED, TestRunBaseline.class)).isEqualTo(BY_PIN);
    assertThat(app.readValue(UNKNOWN_OBJECT, TestRunBaseline.class)).isEqualTo(new TestRunBaseline.Unrecognized(UNKNOWN_PROPERTIES));
    assertThat(app.readValue("{}", TestRunBaseline.class)).isEqualTo(new TestRunBaseline.Unrecognized(Map.of()));
    assertThat(app.readValue("[\"recorded\"," + PINNED + "]", new TypeReference<List<TestRunBaseline>>() {}))
        .containsExactly(TestRunBaseline.RECORDED, BY_PIN);

    String body = "{\"projectId\":\"" + PROJECT + "\",\"baseline\":%s}";
    assertThat(app.readValue(body.formatted("\"recorded\""), StartTestRunBody.class).baseline()).isEqualTo(TestRunBaseline.RECORDED);
    assertThat(app.readValue(body.formatted(AGENT_ID), StartTestRunBody.class).baseline()).isEqualTo(BY_AGENT);
    assertThat(app.readValue(body.formatted("null"), StartTestRunBody.class).baseline()).isNull();
    assertThat(app.readValue("{\"projectId\":\"" + PROJECT + "\"}", StartTestRunBody.class).baseline()).isNull();

    assertThat(app.writeValueAsString(TestRunBaseline.RECORDED)).isEqualTo("\"recorded\"");
    assertThat(app.writeValueAsString(BY_AGENT)).isEqualTo(AGENT_ID);
    assertThat(app.writeValueAsString(List.of(TestRunBaseline.RECORDED, BY_AGENT))).isEqualTo("[\"recorded\"," + AGENT_ID + "]");
    assertThat(app.writeValueAsString(app.readValue(body.formatted(PINNED), StartTestRunBody.class)))
        .isEqualTo(body.formatted(PINNED));
    assertThat(app.readTree(app.writeValueAsString(app.readValue(UNKNOWN_OBJECT, TestRunBaseline.class))))
        .isEqualTo(app.readTree(UNKNOWN_OBJECT));
  }

  /**
   * Each object of a text-or-object union reads as itself where it's the declared type, Unrecognized
   * too: a known variant's properties are then its properties. And so through the client codec's
   * own path, the tree first and then the variant's class.
   */
  @Test
  void readsEachObjectOfATextOrObjectUnionAsItself() throws Exception {
    assertThat(app.readValue(AGENT_ID, TestRunBaseline.WithAgentId.class)).isEqualTo(BY_AGENT);
    assertThat(app.readValue(PINNED, TestRunBaseline.WithPinned.class)).isEqualTo(BY_PIN);
    assertThat(app.readValue(UNKNOWN_OBJECT, TestRunBaseline.Unrecognized.class).properties()).isEqualTo(UNKNOWN_PROPERTIES);
    assertThat(app.readValue("{}", TestRunBaseline.Unrecognized.class).properties()).isEqualTo(Map.of());
    assertThat(app.readValue(AGENT_ID, TestRunBaseline.Unrecognized.class).properties())
        .isEqualTo(Map.of("agentId", "acme.bookkeeper", "version", "1.0.0"));
    assertThat(app.readTree(app.writeValueAsString(app.readValue(UNKNOWN_OBJECT, TestRunBaseline.Unrecognized.class))))
        .isEqualTo(app.readTree(UNKNOWN_OBJECT));

    assertThat(viaTree(TestRunBaseline.Unrecognized.class, UNKNOWN_OBJECT).properties()).isEqualTo(UNKNOWN_PROPERTIES);
    assertThat(viaTree(TestRunBaseline.Unrecognized.class, "{}").properties()).isEqualTo(Map.of());
    assertThat(viaTree(TestRunBaseline.WithAgentId.class, withExtra(AGENT_ID))).isEqualTo(BY_AGENT);
    assertThat(viaTree(TestRunBaseline.WithPinned.class, PINNED)).isEqualTo(BY_PIN);
  }

  /** An agent's instructions are a text or a prompt ref, so an agent reads with either. */
  @Test
  void readsAnAgentWhoseInstructionsAreATextOrAPromptRef() throws Exception {
    PromptRef ref = new PromptRef("acme.tone", "^1.0.0");
    assertThat(app.readValue("\"You help.\"", AgentInstructions.class)).isEqualTo(AgentInstructions.of("You help."));
    assertThat(app.readValue(PROMPT_REF, AgentInstructions.class)).isEqualTo(ref);
    String agent =
        "{\"id\":\"acme.bookkeeper\",\"version\":\"1.0.0\",\"name\":\"Bookkeeper\",\"instructions\":%s,"
            + "\"capabilities\":[],\"tools\":[],\"retrieval\":[],\"guardrails\":[]}";
    assertThat(app.readValue(agent.formatted(PROMPT_REF), Agent.class).instructions()).isEqualTo(ref);
    assertThat(app.readValue(agent.formatted("\"You help.\""), Agent.class).instructions()).isEqualTo(AgentInstructions.of("You help."));
    assertThat(app.writeValueAsString(AgentInstructions.of("You help."))).isEqualTo("\"You help.\"");
    assertThat(app.writeValueAsString(ref)).isEqualTo(PROMPT_REF);
  }

  /**
   * A secret rotation's answer is told apart by its {@code kind}, a newer property left out. A
   * by-status answer's {@code kind} never gains a value, so one it doesn't know fails.
   */
  @Test
  void readsASecretRotationsAnswerByItsKind() throws Exception {
    String async = "{\"kind\":\"async\",\"rotationId\":\"" + PROJECT + "\",\"statusUrl\":\"/s\",\"eventsUrl\":\"/e\"}";
    SecretsRotateResponse sync = app.readValue(ROTATED, SecretsRotateResponse.class);
    assertThat(sync).isInstanceOf(SecretRotateResponseSync.class);
    assertThat(((SecretRotateResponseSync) sync).newVersionId()).isEqualTo(2L);
    assertThat(app.readValue(async, SecretsRotateResponse.class)).isInstanceOf(SecretRotateResponseAsync.class);
    assertThat(app.readValue(withExtra(async), SecretsRotateResponse.class)).isInstanceOf(SecretRotateResponseAsync.class);
    assertThat(app.readValue(async, SecretRotateResponseAsync.class).kind().asString()).isEqualTo("async");
    assertThat(app.readTree(app.writeValueAsString(sync))).isEqualTo(app.readTree(ROTATED));
    assertThat(app.readTree(app.writeValueAsString(app.readValue(async, SecretsRotateResponse.class)))).isEqualTo(app.readTree(async));
    assertThatThrownBy(() -> app.readValue(async.replace("async", "later"), SecretsRotateResponse.class))
        .isInstanceOf(InvalidTypeIdException.class);
  }

  /** {@code json}, an object, with a property this client doesn't know. */
  private static String withExtra(String json) {
    return json.substring(0, json.length() - 1) + ",\"kindgiTestExtra\":1}";
  }

  private static boolean delegatingCreator(Class<?> type) {
    for (Method m : type.getDeclaredMethods()) {
      JsonCreator creator = m.getAnnotation(JsonCreator.class);
      if (creator != null && creator.mode() == JsonCreator.Mode.DELEGATING) {
        return true;
      }
    }
    return false;
  }

  private record Holder(Object value) {}

  /** {@code json} read as the client's codec reads a union's object: the tree, then the variant's class. */
  private <T> T viaTree(Class<T> variant, String json) throws IOException {
    ObjectMapper mapper =
        app.copy()
            .registerModule(
                new SimpleModule()
                    .addDeserializer(
                        Holder.class,
                        new StdDeserializer<Holder>(Holder.class) {
                          @Override
                          public Holder deserialize(JsonParser p, DeserializationContext ctxt) throws IOException {
                            JsonNode node = p.readValueAsTree();
                            return new Holder(ctxt.readTreeAsValue(node, variant));
                          }
                        }));
    return variant.cast(mapper.readValue(json, Holder.class).value());
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
