// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.kindgi.client.models.CreateWebhookEndpointBody;
import com.kindgi.client.models.TestRunBaseline;
import com.kindgi.client.models.TestRunComparison;
import com.kindgi.client.models.AgentPinScope;
import com.kindgi.client.models.MintSystemKeyBody;
import com.kindgi.client.models.MintTokenBody;
import com.kindgi.client.models.Pin;
import com.kindgi.client.models.ServiceAccountGrantBody;
import com.kindgi.client.models.StartTestRunBody;
import com.kindgi.client.models.AgentUnpinBody;
import com.kindgi.client.models.UpdateIdentityProviderBody;
import com.kindgi.client.models.ValidationException;
import com.kindgi.client.models.WebhookEndpoint;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * A value this client doesn't know, read from a newer runtime (an enum value, a union's text
 * value, a union variant): it's kept on a read and through a builder, and refused before it's
 * sent, so the server never sees it. The Python client refuses the same (tests/test_open_enums.py).
 */
class KnownValuesOnSendTest {
  private static final String UNKNOWN = "kindgi-test-unknown";
  private static final String PIN_CHANGE =
      "{\"id\":\"f531e37d-f29f-463c-81d2-ffad65e4d4e9\",\"agentId\":\"acme.triage\",\"scope\":%s,\"action\":\"unpin\","
          + "\"fromVersion\":\"1.0.0\",\"toVersion\":null,\"requestedBy\":{\"kind\":\"user\",\"id\":\"acme-admin\"},"
          + "\"createdAt\":\"2026-10-18T00:00:00Z\"}";

  private HttpServer server;
  /** The bodies the server got. */
  private final List<String> sent = new CopyOnWriteArrayList<>();
  private volatile String answer = "{}";
  private Kindgi client;

  @BeforeEach
  void start() throws IOException {
    server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext(
        "/",
        exchange -> {
          sent.add(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
          byte[] bytes = answer.getBytes(StandardCharsets.UTF_8);
          exchange.getResponseHeaders().set("Content-Type", "application/json");
          exchange.sendResponseHeaders(200, bytes.length);
          try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
          }
          exchange.close();
        });
    server.start();
    client =
        Kindgi.builder()
            .baseUrl("http://127.0.0.1:" + server.getAddress().getPort() + "/")
            .token("kgi_test")
            .timeout(Duration.ofSeconds(5))
            .build();
  }

  @AfterEach
  void stop() {
    server.stop(0);
  }

  @Test
  void anEnumValueItDoesntKnowIsntSentAtTheTopOrNested() {
    MintTokenBody body =
        KindgiJson.read("{\"for\":{\"kind\":\"" + UNKNOWN + "\",\"id\":\"acme-admin\"},\"role\":\"" + UNKNOWN + "\"}", MintTokenBody.class);
    assertThatThrownBy(() -> client.tokens().mint(body))
        .isInstanceOf(ValidationException.class)
        .hasMessage("MintTokenBody is invalid: for.kind: must be one of user, service-account; role: must be one of admin, member");
    assertThat(sent).isEmpty();
  }

  @Test
  void anEnumValueItDoesntKnowIsntSentInAList() {
    MintSystemKeyBody body = KindgiJson.read("{\"scopes\":[\"system:tenants\",\"" + UNKNOWN + "\"]}", MintSystemKeyBody.class);
    assertThatThrownBy(() -> client.systemKeys().mint(body))
        .isInstanceOf(ValidationException.class)
        .hasMessageStartingWith("MintSystemKeyBody is invalid: scopes[1]: must be one of system:tenants, ");
    assertThat(sent).isEmpty();
  }

  @Test
  void anEnumValueItDoesntKnowIsntSentInAFieldThatMayBeNull() {
    UpdateIdentityProviderBody body = KindgiJson.read("{\"join\":\"" + UNKNOWN + "\"}", UpdateIdentityProviderBody.class);
    assertThatThrownBy(() -> client.auth().providers().update("acme-sso", body))
        .isInstanceOf(ValidationException.class)
        .hasMessage("UpdateIdentityProviderBody is invalid: join: must be one of invite, domain");
    assertThat(sent).isEmpty();
  }

  @Test
  void aUnionVariantItDoesntKnowIsntSent() {
    ServiceAccountGrantBody body = KindgiJson.read("{\"kind\":\"" + UNKNOWN + "\",\"role\":\"admin\"}", ServiceAccountGrantBody.class);
    assertThat(body).isInstanceOf(ServiceAccountGrantBody.Unrecognized.class);
    assertThatThrownBy(() -> client.serviceAccounts().grant("acme-bot", body))
        .isInstanceOf(ValidationException.class)
        .hasMessage("ServiceAccountGrantBody.Unrecognized is invalid: kind: must be one of tenant-admin, tenant-member, project");
    assertThat(sent).isEmpty();
  }

  @Test
  void aScopeReadFromANewerRuntimeIsKeptButNotSentBack() {
    answer = String.format(PIN_CHANGE, "{\"kind\":\"galaxy\",\"galaxyId\":\"milky-way\"}");
    Pin pin = client.agents().pinned().unpin("acme.triage", new AgentUnpinBody(KindgiJson.read("{\"kind\":\"tenant\"}", AgentPinScope.class), null));
    assertThat(pin.scope()).isInstanceOf(AgentPinScope.Unrecognized.class);
    assertThatCode(() -> pin.toBuilder().build()).doesNotThrowAnyException();
    assertThatCode(() -> AgentUnpinBody.builder().scope(pin.scope()).build()).doesNotThrowAnyException();

    AgentUnpinBody back = AgentUnpinBody.builder().scope(pin.scope()).build();
    assertThatThrownBy(() -> client.agents().pinned().unpin("acme.triage", back))
        .isInstanceOf(ValidationException.class)
        .hasMessageStartingWith("AgentUnpinBody is invalid: scope.kind: must be one of tenant, ");
    assertThat(sent).hasSize(1);
  }

  @Test
  void eventsReadFromANewerRuntimeAreKeptButNotSentBack() {
    answer =
        "{\"endpointId\":\"we_1\",\"url\":\"https://acme.test/hook\",\"events\":[\"run.finished\",\"" + UNKNOWN + "\"],"
            + "\"filter\":{},\"description\":null,\"secretRef\":{\"envName\":\"prod\",\"name\":\"HOOK\"},"
            + "\"createdAt\":\"2026-10-18T00:00:00Z\",\"updatedAt\":\"2026-10-18T00:00:00Z\"}";
    WebhookEndpoint endpoint = client.webhookEndpoints().get("we_1");
    assertThat(endpoint.events().get(1).isKnown()).isFalse();
    assertThat(endpoint.events().get(1).asString()).isEqualTo(UNKNOWN);
    assertThatCode(() -> endpoint.toBuilder().build()).doesNotThrowAnyException();

    CreateWebhookEndpointBody copy =
        CreateWebhookEndpointBody.builder().url(endpoint.url()).events(endpoint.events()).secretRef(endpoint.secretRef()).build();
    assertThatThrownBy(() -> client.webhookEndpoints().create(copy))
        .isInstanceOf(ValidationException.class)
        .hasMessageStartingWith("CreateWebhookEndpointBody is invalid: events[1]: must be one of run.finished, ");
    assertThat(sent).hasSize(1);
  }

  @Test
  void aBaselineReadFromANewerRuntimeIsKeptButNotSentBack() {
    // TestRunBaseline is in an answer and a body: text this client doesn't know reads as the text.
    TestRunComparison comparison =
        KindgiJson.read("{\"baseline\":\"" + UNKNOWN + "\",\"reads\":\"" + UNKNOWN + "\",\"repetitions\":1,\"k\":1}", TestRunComparison.class);
    assertThat(comparison.baseline()).isEqualTo(TestRunBaseline.of(UNKNOWN));
    assertThatCode(() -> comparison.toBuilder().build()).doesNotThrowAnyException();

    StartTestRunBody start =
        KindgiJson.read("{\"projectId\":\"f531e37d-f29f-463c-81d2-ffad65e4d4e9\",\"agentRef\":{\"agentId\":\"acme.triage\"}}", StartTestRunBody.class);
    assertThatCode(() -> start.toBuilder().baseline(comparison.baseline()).build()).doesNotThrowAnyException();
    StartTestRunBody back = start.toBuilder().baseline(comparison.baseline()).build();
    assertThatThrownBy(() -> client.testRuns().start("acme.suite", back))
        .isInstanceOf(ValidationException.class)
        .hasMessage("StartTestRunBody is invalid: baseline: must be one of recorded");
    assertThat(sent).isEmpty();

    // A value it knows is sent as before.
    answer = "{\"testRunId\":\"f531e37d-f29f-463c-81d2-ffad65e4d4e9\"}";
    client.testRuns().start("acme.suite", start.toBuilder().baseline(TestRunBaseline.RECORDED).build());
    assertThat(sent).hasSize(1);
    assertThat(sent.get(0)).contains("\"baseline\":\"recorded\"");
  }
}
