// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.kindgi.client.models.Agent;
import com.kindgi.client.models.AgentInstructions;
import com.kindgi.client.models.PromptRef;
import com.kindgi.client.models.SecretRotateResponseAsync;
import com.kindgi.client.models.SecretRotateResponseSync;
import com.kindgi.client.models.SecretsRotateResponse;
import com.kindgi.client.models.StartTestRunBody;
import com.kindgi.client.models.TestRunBaseline;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.core.JsonParser;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.DeserializationContext;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.deser.std.StdDeserializer;
import tools.jackson.databind.exc.InvalidTypeIdException;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.module.SimpleModule;

/**
 * An app's own Jackson 3 mapper reads and writes the unions told apart by text or by a required
 * property, through the models' annotations, as {@code AppJacksonTest} does on Jackson 2. Each
 * case has the client's own codec as its control: it reads the same JSON to the same value.
 */
class AppJackson3Test {
  private static final String PROJECT = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
  private static final String AGENT_ID = "{\"agentId\":\"acme.bookkeeper\",\"version\":\"1.0.0\"}";
  private static final String PINNED = "{\"pinned\":{\"projectId\":\"p1\"}}";
  private static final String PROMPT_REF = "{\"prompt\":\"acme.tone\",\"version\":\"^1.0.0\"}";
  private static final String ROTATED = "{\"kind\":\"sync\",\"newVersionId\":2,\"oldVersionId\":1}";
  private static final String ASYNC =
      "{\"kind\":\"async\",\"rotationId\":\"" + PROJECT + "\",\"statusUrl\":\"/s\",\"eventsUrl\":\"/e\"}";
  private static final String UNKNOWN_OBJECT = "{\"galaxy\":3,\"arm\":\"x\"}";
  private static final Map<String, Object> UNKNOWN_PROPERTIES = Map.of("galaxy", 3, "arm", "x");
  private static final String AGENT =
      "{\"id\":\"acme.bookkeeper\",\"version\":\"1.0.0\",\"name\":\"Bookkeeper\",\"instructions\":%s,"
          + "\"capabilities\":[],\"tools\":[],\"retrieval\":[],\"guardrails\":[]}";
  private static final String BODY = "{\"projectId\":\"" + PROJECT + "\",\"baseline\":%s}";
  private static final TestRunBaseline.WithAgentId BY_AGENT = new TestRunBaseline.WithAgentId("acme.bookkeeper", "1.0.0");
  private static final TestRunBaseline.WithPinned BY_PIN =
      new TestRunBaseline.WithPinned(new TestRunBaseline.WithPinned.Pinned("p1", null));

  private final JsonMapper app = JsonMapper.builder().disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES).build();

  /** {@code json} read by the app's mapper, after the client's codec read it to the same value. */
  private <T> T read(String json, Class<T> type) {
    T value = app.readValue(json, type);
    assertThat(KindgiJson.read(json, type)).as("the client's codec: " + json).isEqualTo(value);
    return value;
  }

  @Test
  void readsAndWritesATextOrObjectUnion() {
    assertThat(read("\"recorded\"", TestRunBaseline.class)).isEqualTo(TestRunBaseline.RECORDED);
    assertThat(read("\"galaxy\"", TestRunBaseline.class)).isEqualTo(TestRunBaseline.of("galaxy"));
    assertThat(read(AGENT_ID, TestRunBaseline.class)).isEqualTo(BY_AGENT);
    assertThat(read(withExtra(AGENT_ID), TestRunBaseline.class)).isEqualTo(BY_AGENT);
    assertThat(read(PINNED, TestRunBaseline.class)).isEqualTo(BY_PIN);
    assertThat(read(UNKNOWN_OBJECT, TestRunBaseline.class)).isEqualTo(new TestRunBaseline.Unrecognized(UNKNOWN_PROPERTIES));
    assertThat(read("{}", TestRunBaseline.class)).isEqualTo(new TestRunBaseline.Unrecognized(Map.of()));
    assertThat(app.readValue("[\"recorded\"," + PINNED + "]", new TypeReference<List<TestRunBaseline>>() {}))
        .containsExactly(TestRunBaseline.RECORDED, BY_PIN);

    assertThat(read(BODY.formatted("\"recorded\""), StartTestRunBody.class).baseline()).isEqualTo(TestRunBaseline.RECORDED);
    assertThat(read(BODY.formatted(AGENT_ID), StartTestRunBody.class).baseline()).isEqualTo(BY_AGENT);
    assertThat(read(BODY.formatted("null"), StartTestRunBody.class).baseline()).isNull();
    assertThat(read("{\"projectId\":\"" + PROJECT + "\"}", StartTestRunBody.class).baseline()).isNull();

    assertThat(app.writeValueAsString(TestRunBaseline.RECORDED)).isEqualTo(KindgiJson.write(TestRunBaseline.RECORDED)).isEqualTo("\"recorded\"");
    assertThat(app.writeValueAsString(BY_AGENT)).isEqualTo(KindgiJson.write(BY_AGENT)).isEqualTo(AGENT_ID);
    assertThat(app.writeValueAsString(List.of(TestRunBaseline.RECORDED, BY_AGENT))).isEqualTo("[\"recorded\"," + AGENT_ID + "]");
    StartTestRunBody pinned = app.readValue(BODY.formatted(PINNED), StartTestRunBody.class);
    assertThat(app.writeValueAsString(pinned)).isEqualTo(KindgiJson.write(pinned)).isEqualTo(BODY.formatted(PINNED));
    TestRunBaseline unknown = app.readValue(UNKNOWN_OBJECT, TestRunBaseline.class);
    assertThat(app.readTree(app.writeValueAsString(unknown))).isEqualTo(app.readTree(UNKNOWN_OBJECT));
  }

  /**
   * Each object reads as itself where it's the declared type, Unrecognized too: a known variant's
   * properties are then its properties. And so through the codec's own path: the tree first,
   * then the variant's class.
   */
  @Test
  void readsEachObjectOfATextOrObjectUnionAsItself() {
    assertThat(read(AGENT_ID, TestRunBaseline.WithAgentId.class)).isEqualTo(BY_AGENT);
    assertThat(read(PINNED, TestRunBaseline.WithPinned.class)).isEqualTo(BY_PIN);
    assertThat(read(UNKNOWN_OBJECT, TestRunBaseline.Unrecognized.class).properties()).isEqualTo(UNKNOWN_PROPERTIES);
    assertThat(read("{}", TestRunBaseline.Unrecognized.class).properties()).isEqualTo(Map.of());
    assertThat(read(AGENT_ID, TestRunBaseline.Unrecognized.class).properties())
        .isEqualTo(Map.of("agentId", "acme.bookkeeper", "version", "1.0.0"));
    TestRunBaseline.Unrecognized unknown = app.readValue(UNKNOWN_OBJECT, TestRunBaseline.Unrecognized.class);
    assertThat(app.readTree(app.writeValueAsString(unknown))).isEqualTo(app.readTree(UNKNOWN_OBJECT));

    assertThat(viaTree(TestRunBaseline.Unrecognized.class, UNKNOWN_OBJECT).properties()).isEqualTo(UNKNOWN_PROPERTIES);
    assertThat(viaTree(TestRunBaseline.Unrecognized.class, "{}").properties()).isEqualTo(Map.of());
    assertThat(viaTree(TestRunBaseline.WithAgentId.class, withExtra(AGENT_ID))).isEqualTo(BY_AGENT);
    assertThat(viaTree(TestRunBaseline.WithPinned.class, PINNED)).isEqualTo(BY_PIN);
  }

  @Test
  void readsAnAgentWhoseInstructionsAreATextOrAPromptRef() {
    PromptRef ref = new PromptRef("acme.tone", "^1.0.0");
    assertThat(read("\"You help.\"", AgentInstructions.class)).isEqualTo(AgentInstructions.of("You help."));
    assertThat(read(PROMPT_REF, AgentInstructions.class)).isEqualTo(ref);
    assertThat(read(AGENT.formatted(PROMPT_REF), Agent.class).instructions()).isEqualTo(ref);
    assertThat(read(AGENT.formatted("\"You help.\""), Agent.class).instructions()).isEqualTo(AgentInstructions.of("You help."));
    assertThat(app.writeValueAsString(AgentInstructions.of("You help."))).isEqualTo("\"You help.\"");
    assertThat(app.writeValueAsString(ref)).isEqualTo(PROMPT_REF);
  }

  /**
   * The client reads a rotation's answer by its HTTP status; an app's mapper by its {@code kind}.
   * A by-status answer's {@code kind} never gains a value, so one it doesn't know fails.
   */
  @Test
  void readsASecretRotationsAnswerByItsKind() {
    SecretsRotateResponse sync = app.readValue(ROTATED, SecretsRotateResponse.class);
    assertThat(sync).isInstanceOf(SecretRotateResponseSync.class);
    assertThat(sync).isEqualTo(KindgiJson.read(ROTATED, SecretRotateResponseSync.class));
    assertThat(app.readValue(ASYNC, SecretsRotateResponse.class))
        .isInstanceOf(SecretRotateResponseAsync.class)
        .isEqualTo(KindgiJson.read(ASYNC, SecretRotateResponseAsync.class));
    assertThat(app.readValue(withExtra(ASYNC), SecretsRotateResponse.class)).isInstanceOf(SecretRotateResponseAsync.class);
    assertThat(read(ASYNC, SecretRotateResponseAsync.class).kind().asString()).isEqualTo("async");
    assertThat(app.readTree(app.writeValueAsString(sync))).isEqualTo(app.readTree(ROTATED));
    assertThatThrownBy(() -> app.readValue(ASYNC.replace("async", "later"), SecretsRotateResponse.class))
        .isInstanceOf(InvalidTypeIdException.class);
  }

  /** {@code json}, an object, with a property this client doesn't know. */
  private static String withExtra(String json) {
    return json.substring(0, json.length() - 1) + ",\"kindgiTestExtra\":1}";
  }

  private record Holder(Object value) {}

  /** {@code json} read as the client's codec reads a union's object: the tree, then the variant's class. */
  private <T> T viaTree(Class<T> variant, String json) {
    JsonMapper mapper =
        app.rebuild()
            .addModule(
                new SimpleModule()
                    .addDeserializer(
                        Holder.class,
                        new StdDeserializer<Holder>(Holder.class) {
                          @Override
                          public Holder deserialize(JsonParser p, DeserializationContext ctxt) {
                            JsonNode node = ctxt.readTree(p);
                            return new Holder(ctxt.readTreeAsValue(node, variant));
                          }
                        }))
            .build();
    return variant.cast(mapper.readValue(json, Holder.class).value());
  }
}
