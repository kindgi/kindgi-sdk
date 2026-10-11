// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.kindgi.client.models.AgentInstructions;
import com.kindgi.client.models.EvalBaseline;
import com.kindgi.client.models.LiveScope;
import com.kindgi.client.models.LiveScopeTenant;
import com.kindgi.client.models.PatchScheduleBody;
import com.kindgi.client.models.PromptRef;
import com.kindgi.client.models.Run;
import com.kindgi.client.models.ScopeSegment;
import com.kindgi.client.models.SecretRotateResponseSync;
import com.kindgi.client.models.SecretsRotateResponse;
import com.kindgi.client.models.StartRunBody;
import com.kindgi.client.models.ValidationException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** The generated models against JSON as the API writes it, through the client's own codec. */
class ModelJsonTest {
  /** The client's codec, as {@link KindgiJson} exposes it. */
  private static final class Codec {
    <T> T readValue(String text, Class<T> type) {
      return KindgiJson.read(text, type);
    }

    String writeValueAsString(Object value) {
      return KindgiJson.write(value);
    }
  }

  private final Codec json = new Codec();

  private static final String RUN =
      "{\"id\":\"6f1c2e1a-1111-4222-8333-944455556666\",\"tenantId\":\"6f1c2e1a-1111-4222-8333-944455556667\","
          + "\"flowId\":\"acme.ledger.record-flow\",\"flowVersion\":\"1\",\"status\":\"running\",\"dryRun\":false,"
          + "\"createdAt\":\"2026-10-07T10:00:00+02:00\",\"updatedAt\":\"2026-10-07T10:00:01Z\",\"someNewField\":{\"x\":1}}";

  @Test
  void aRecordReadsAndIgnoresPropertiesItDoesntKnow() {
    Run run = json.readValue(RUN, Run.class);
    assertThat(run.id()).isEqualTo(UUID.fromString("6f1c2e1a-1111-4222-8333-944455556666"));
    assertThat(run.status().value()).isEqualTo(Run.Status.Value.RUNNING);
    assertThat(run.createdAt()).isEqualTo(OffsetDateTime.parse("2026-10-07T10:00:00+02:00"));
    assertThat(run.createdAt().getOffset().getTotalSeconds()).isEqualTo(7200);
    assertThat(run.output()).isNull();
  }

  @Test
  void aMissingRequiredPropertyFailsTheRead() {
    assertThatThrownBy(() -> json.readValue(RUN.replace("\"flowVersion\":\"1\",", ""), Run.class))
        .isInstanceOf(KindgiJsonException.class)
        .hasMessageContaining("Run.flowVersion: is required");
  }

  @Test
  void anEnumKeepsAValueItDoesntKnow() {
    Run run = json.readValue(RUN.replace("\"running\"", "\"hibernating\""), Run.class);
    assertThat(run.status().value()).isEqualTo(Run.Status.Value.UNRECOGNIZED);
    assertThat(run.status().isKnown()).isFalse();
    assertThat(run.status().asString()).isEqualTo("hibernating");
    assertThat(json.writeValueAsString(run.status())).isEqualTo("\"hibernating\"");
    assertThat(Run.Status.of("running")).isSameAs(Run.Status.RUNNING);
  }

  @Test
  void aTaggedUnionReadsItsVariantAndKeepsOneItDoesntKnow() {
    LiveScope tenant = json.readValue("{\"kind\":\"tenant\"}", LiveScope.class);
    assertThat(tenant).isInstanceOf(LiveScopeTenant.class);
    assertThat(tenant.kind()).isEqualTo("tenant");
    LiveScope other = json.readValue("{\"kind\":\"galaxy\",\"arm\":3}", LiveScope.class);
    assertThat(other).isInstanceOf(LiveScope.Unrecognized.class);
    assertThat(((LiveScope.Unrecognized) other).properties()).containsEntry("arm", 3);
    assertThat(json.writeValueAsString(other)).isEqualTo("{\"kind\":\"galaxy\",\"arm\":3}");
  }

  @Test
  void aUnionToldApartByItsPropertiesWritesAndReads() {
    StartRunBody body =
        StartRunBody.WithAgent.builder().agent("acme.bookkeeper").input(Map.of("userMessage", "hi")).build();
    String written = json.writeValueAsString(body);
    assertThat(written).isEqualTo("{\"agent\":\"acme.bookkeeper\",\"input\":{\"userMessage\":\"hi\"}}");
    assertThat(json.readValue(written, StartRunBody.class)).isEqualTo(body);
    assertThat(json.readValue("{\"flow\":\"acme.ledger.record-flow\",\"input\":{}}", StartRunBody.class))
        .isInstanceOf(StartRunBody.WithFlow.class);
  }

  @Test
  void aTextOrObjectUnionReadsBoth() {
    AgentInstructions text = json.readValue("\"Be brief.\"", AgentInstructions.class);
    assertThat(text).isEqualTo(AgentInstructions.of("Be brief."));
    assertThat(json.writeValueAsString(text)).isEqualTo("\"Be brief.\"");
    AgentInstructions ref = json.readValue("{\"prompt\":\"acme.tone\",\"version\":\"^1.0.0\"}", AgentInstructions.class);
    assertThat(ref).isEqualTo(new PromptRef("acme.tone", "^1.0.0"));
    assertThat(json.writeValueAsString(ref)).isEqualTo("{\"prompt\":\"acme.tone\",\"version\":\"^1.0.0\"}");

    EvalBaseline recorded = json.readValue("\"recorded\"", EvalBaseline.class);
    assertThat(recorded).isEqualTo(EvalBaseline.RECORDED);
    assertThat(json.readValue("{\"agentId\":\"a\",\"version\":\"2\"}", EvalBaseline.class)).isInstanceOf(EvalBaseline.WithAgentId.class);
    assertThat(json.readValue("{\"live\":{}}", EvalBaseline.class)).isInstanceOf(EvalBaseline.WithLive.class);
    assertThat(json.readValue("{\"somethingElse\":1}", EvalBaseline.class)).isInstanceOf(EvalBaseline.Unrecognized.class);
  }

  @Test
  void anUpdateTellsLeavingOutFromClearing() {
    assertThat(json.writeValueAsString(PatchScheduleBody.builder().flowVersion("2").build())).isEqualTo("{\"flowVersion\":\"2\"}");
    assertThat(json.writeValueAsString(PatchScheduleBody.builder().label(null).build())).isEqualTo("{\"label\":null}");
    assertThat(json.writeValueAsString(PatchScheduleBody.builder().label("nightly").build())).isEqualTo("{\"label\":\"nightly\"}");
  }

  @Test
  void aBuilderChecksTheApisConstraintsAndListsEveryProblem() {
    assertThatThrownBy(() -> ScopeSegment.builder().key("Not Lowercase").value("").build())
        .isInstanceOfSatisfying(
            ValidationException.class,
            e -> assertThat(e.violations())
                .containsExactly("key: must match ^[a-z][a-z0-9_-]{0,63}$", "value: must be at least 1 character long"));
  }

  @Test
  void aResponseIsntHeldToTheConstraints() {
    // A newer runtime may relax a constraint: reading doesn't check them, validate() does.
    ScopeSegment s = json.readValue("{\"key\":\"Not Lowercase\",\"value\":\"x\"}", ScopeSegment.class);
    assertThat(s.key()).isEqualTo("Not Lowercase");
    assertThatThrownBy(s::validate).isInstanceOf(ValidationException.class);
  }

  @Test
  void aRecordIsImmutable() {
    StartRunBody.WithAgent body =
        StartRunBody.WithAgent.builder().agent("acme.bookkeeper").input(Map.of()).segments(new java.util.ArrayList<>(List.of())).build();
    assertThatThrownBy(() -> body.segments().add(null)).isInstanceOf(UnsupportedOperationException.class);
  }

  @Test
  void anUpdateReadBackKeepsAnExplicitNull() {
    assertThat(json.readValue("{\"label\":null}", PatchScheduleBody.class).label().isPresent()).isTrue();
    assertThat(json.readValue("{}", PatchScheduleBody.class).label().isAbsent()).isTrue();
    assertThat(json.readValue("{\"label\":\"x\"}", PatchScheduleBody.class).label().get()).isEqualTo("x");
  }

  @Test
  void aRequiredOneValueEnumStartsFilledIn() {
    SecretRotateResponseSync sync =
        json.readValue("{\"kind\":\"sync\",\"newVersionId\":2,\"oldVersionId\":1}", SecretRotateResponseSync.class);
    assertThat(sync.kind()).isSameAs(SecretRotateResponseSync.Kind.SYNC);
    assertThat(SecretRotateResponseSync.builder().newVersionId(3L).oldVersionId(2L).build().kind()).isSameAs(SecretRotateResponseSync.Kind.SYNC);
    assertThat(sync).isInstanceOf(SecretsRotateResponse.class);
  }
}
