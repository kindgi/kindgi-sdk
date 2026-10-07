// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.kindgi.client.models.Run;
import com.kindgi.client.models.RunEvent;
import com.kindgi.client.models.RunProgressEvent;
import com.kindgi.client.models.ScopeSegment;
import com.kindgi.client.models.StartRunBody;
import com.kindgi.client.models.ValidationException;
import com.kindgi.client.resources.AgentsLiveResolveParams;
import com.kindgi.client.resources.ApprovalsListParams;
import com.kindgi.client.resources.RunsListParams;
import com.kindgi.client.resources.RunsStartParams;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** The client against a local HTTP server: what it sends, retries, and reads. */
class TransportTest {
  private static final UUID RUN_ID = UUID.fromString("6f1c2e1a-1111-4222-8333-944455556666");
  private static final String RUN =
      "{\"id\":\"" + RUN_ID + "\",\"tenantId\":\"6f1c2e1a-1111-4222-8333-944455556667\",\"flowId\":\"acme.f\","
          + "\"flowVersion\":\"1\",\"status\":\"completed\",\"dryRun\":false,\"createdAt\":\"2026-10-07T10:00:00Z\","
          + "\"updatedAt\":\"2026-10-07T10:00:01Z\"}";

  /** One request the server saw. */
  record Seen(String method, String uri, Map<String, List<String>> headers, String body) {
    String header(String name) {
      for (Map.Entry<String, List<String>> e : headers.entrySet()) {
        if (e.getKey() != null && e.getKey().equalsIgnoreCase(name)) {
          return e.getValue().get(0);
        }
      }
      return null;
    }
  }

  /** Thrown by a handler to drop the connection. */
  static final class Drop extends RuntimeException {
    private static final long serialVersionUID = 1L;
  }

  /** What the server answers. */
  interface Handler {
    void handle(HttpExchange exchange, int call) throws IOException;
  }

  private HttpServer server;
  private final List<Seen> seen = new CopyOnWriteArrayList<>();
  private final AtomicInteger calls = new AtomicInteger();
  private volatile Handler handler;
  private Kindgi client;

  @BeforeEach
  void start() throws IOException {
    server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext(
        "/",
        exchange -> {
          String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
          seen.add(new Seen(exchange.getRequestMethod(), exchange.getRequestURI().toString(), Map.copyOf(exchange.getRequestHeaders()), body));
          try {
            handler.handle(exchange, calls.incrementAndGet());
          } catch (Drop drop) {
            // The server closes the connection without ending the body: a dropped stream.
            throw new IOException("dropped");
          }
          exchange.close();
        });
    server.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
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

  private static void answer(HttpExchange exchange, int status, String json, String... headers) throws IOException {
    byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
    exchange.getResponseHeaders().set("Content-Type", "application/json");
    for (int i = 0; i < headers.length; i += 2) {
      exchange.getResponseHeaders().set(headers[i], headers[i + 1]);
    }
    exchange.sendResponseHeaders(status, bytes.length == 0 ? -1 : bytes.length);
    if (bytes.length > 0) {
      try (OutputStream out = exchange.getResponseBody()) {
        out.write(bytes);
      }
    }
  }

  @Test
  void aCallSendsTheTokenAndReadsTheModel() {
    handler = (ex, n) -> answer(ex, 200, RUN);
    Run run = client.runs().get(RUN_ID);
    assertThat(run.id()).isEqualTo(RUN_ID);
    Seen s = seen.get(0);
    assertThat(s.method()).isEqualTo("GET");
    assertThat(s.uri()).isEqualTo("/v1/runs/" + RUN_ID);
    assertThat(s.header("Authorization")).isEqualTo("Bearer kgi_test");
    assertThat(s.header("User-Agent")).startsWith("kindgi-java/");
  }

  @Test
  void queryParametersAreWrittenAsTheApiReadsThem() {
    handler = (ex, n) -> answer(ex, 200, "{\"data\":[],\"hasMore\":false}");
    client.runs().list(RunsListParams.builder().limit(5L).topLevel(true).replays(RunsListParams.Replays.ONLY).build());
    assertThat(seen.get(0).uri()).isEqualTo("/v1/runs?limit=5&topLevel=true&replays=only");
    client.approvals().list(ApprovalsListParams.builder().createdAfter(OffsetDateTime.of(2026, 10, 7, 12, 0, 0, 0, ZoneOffset.UTC)).build());
    assertThat(seen.get(1).uri()).isEqualTo("/v1/approvals?createdAfter=2026-10-07T12:00:00Z");
  }

  @Test
  void aSegmentPathIsRepeatedKeyValueSteps() {
    handler = (ex, n) -> answer(ex, 200, "{}");
    try {
      client.agents().live().resolve("acme.bookkeeper", AgentsLiveResolveParams.builder()
          .segments(List.of(ScopeSegment.builder().key("company").value("acme co").build(), ScopeSegment.builder().key("region").value("eu").build()))
          .build());
    } catch (KindgiApiException e) {
      // The answer's shape doesn't matter here.
    }
    assertThat(seen.get(0).uri()).endsWith("segment=company:acme%20co&segment=region:eu");
  }

  @Test
  void aStartIsRetriedWithTheSameIdempotencyKey() {
    handler = (ex, n) -> {
      if (n == 1) {
        answer(ex, 503, "{\"error\":{\"code\":\"unavailable\",\"message\":\"busy\"}}", "Retry-After", "0");
      } else {
        answer(ex, 201, RUN);
      }
    };
    Run run = client.runs().start(StartRunBody.WithAgent.builder().agent("acme.bookkeeper").input(Map.of("userMessage", "hi")).build());
    assertThat(run.id()).isEqualTo(RUN_ID);
    assertThat(seen).hasSize(2);
    String key = seen.get(0).header("Idempotency-Key");
    assertThat(key).isNotBlank();
    assertThat(seen.get(1).header("Idempotency-Key")).isEqualTo(key);
    assertThat(seen.get(0).header("Content-Type")).isEqualTo("application/json");
    assertThat(seen.get(0).body()).isEqualTo("{\"agent\":\"acme.bookkeeper\",\"input\":{\"userMessage\":\"hi\"}}");
  }

  @Test
  void aCallersIdempotencyKeyIsKept() {
    handler = (ex, n) -> answer(ex, 201, RUN);
    client.runs().start(
        StartRunBody.WithAgent.builder().agent("a").input(Map.of()).build(), RunsStartParams.builder().idempotencyKey("mine").build());
    assertThat(seen.get(0).header("Idempotency-Key")).isEqualTo("mine");
  }

  @Test
  void aCallThatIsntSafeToRepeatIsntRetried() {
    handler = (ex, n) -> answer(ex, 503, "{\"error\":{\"code\":\"unavailable\",\"message\":\"busy\"}}", "Retry-After", "0");
    assertThatThrownBy(() -> client.retention().sweep()).isInstanceOf(ServerException.class);
    assertThat(seen).hasSize(1);
  }

  @Test
  void retriesStopAfterMaxRetries() {
    handler = (ex, n) -> answer(ex, 503, "{\"error\":{\"code\":\"unavailable\",\"message\":\"busy\"}}", "Retry-After", "0");
    assertThatThrownBy(() -> client.runs().get(RUN_ID)).isInstanceOf(ServerException.class);
    assertThat(seen).hasSize(3);
  }

  @Test
  void anErrorIsTyped() {
    handler = (ex, n) -> answer(ex, 404, "{\"error\":{\"code\":\"run-not-found\",\"message\":\"No run.\",\"details\":{\"runId\":\"" + RUN_ID + "\"}}}");
    assertThatThrownBy(() -> client.runs().get(RUN_ID))
        .isInstanceOfSatisfying(NotFoundException.class, e -> {
          assertThat(e.kind()).isEqualTo("run");
          assertThat(e.id()).isEqualTo(RUN_ID.toString());
          assertThat(e.serverCode()).isEqualTo("run-not-found");
        });
  }

  @Test
  void anAnswerThatBreaksTheSchemaSaysSo() {
    handler = (ex, n) -> answer(ex, 200, "{\"id\":\"" + RUN_ID + "\"}");
    assertThatThrownBy(() -> client.runs().get(RUN_ID))
        .isInstanceOfSatisfying(KindgiApiException.class, e -> {
          assertThat(e.serverCode()).isEqualTo("invalid-response");
          assertThat(e.getMessage()).startsWith("runs.get: the response doesn't match the API's schema");
        });
  }

  @Test
  void aBodyThatBreaksTheConstraintsIsntSent() {
    handler = (ex, n) -> answer(ex, 201, RUN);
    StartRunBody bad = new StartRunBody.WithAgent("acme.bookkeeper", null, null, List.of(new ScopeSegment("Not Lowercase", "x")), Map.of(), null);
    assertThatThrownBy(() -> client.runs().start(bad))
        .isInstanceOf(ValidationException.class)
        .hasMessageContaining("segments[0].key: must match");
    assertThat(seen).isEmpty();
  }

  @Test
  void asyncCallsCompleteAndFailTyped() {
    handler = (ex, n) -> {
      if (ex.getRequestURI().getPath().endsWith("/missing")) {
        answer(ex, 404, "{\"error\":{\"code\":\"agent-not-found\",\"message\":\"No agent.\"}}");
      } else {
        answer(ex, 200, RUN);
      }
    };
    KindgiAsync async = client.async();
    assertThat(async.runs().get(RUN_ID).join().id()).isEqualTo(RUN_ID);
    assertThatThrownBy(() -> async.agents().get("missing").join())
        .isInstanceOf(CompletionException.class)
        .hasCauseInstanceOf(NotFoundException.class);
  }

  private static String event(int sequence) {
    return event(sequence, "run.step-completed");
  }

  private static String event(int sequence, String kind) {
    return "{\"eventId\":\"" + RUN_ID + ":" + sequence + "\",\"runId\":\"" + RUN_ID + "\",\"tenantId\":\"t\","
        + "\"timestamp\":\"2026-10-07T10:00:0" + sequence + "Z\",\"kind\":\"" + kind + "\",\"sequence\":" + sequence + "}";
  }

  private static String frame(int sequence, String kind) {
    return "id: a:" + sequence + "\ndata: " + event(sequence, kind) + "\n\n";
  }

  private static void sse(HttpExchange ex, String body, boolean drop) throws IOException {
    ex.getResponseHeaders().set("Content-Type", "text/event-stream");
    ex.sendResponseHeaders(200, 0);
    OutputStream out = ex.getResponseBody();
    out.write(body.getBytes(StandardCharsets.UTF_8));
    out.flush();
    if (drop) {
      throw new Drop();
    }
    out.close();
  }

  @Test
  void aStreamReadsEventsSkipsBadDataAndEndsWhenTheServerCloses() {
    handler = (ex, n) -> sse(ex, ": keep-alive\n\nid: a:1\ndata: " + event(1) + "\n\ndata: not json\n\nid: a:2\nevent: message\ndata: " + event(2) + "\n\n", false);
    List<Long> sequences = new ArrayList<>();
    try (EventStream<RunEvent> events = client.runs().stream(RUN_ID)) {
      for (RunEvent e : events) {
        sequences.add(e.sequence());
      }
      assertThat(events.lastEventId()).isEqualTo("a:2");
    }
    assertThat(sequences).containsExactly(1L, 2L);
    assertThat(seen.get(0).header("Accept")).isEqualTo("text/event-stream");
  }

  @Test
  void aDroppedStreamResumesWithLastEventId() {
    handler = (ex, n) -> sse(ex, n == 1 ? "id: a:1\ndata: " + event(1) + "\n\n" : "id: a:2\ndata: " + event(2) + "\n\n", n == 1);
    List<Long> sequences = Collections.synchronizedList(new ArrayList<>());
    try (EventStream<RunEvent> events = client.runs().stream(RUN_ID)) {
      events.forEachRemaining(e -> sequences.add(e.sequence()));
    }
    assertThat(sequences).containsExactly(1L, 2L);
    assertThat(seen).hasSize(2);
    assertThat(seen.get(1).header("Last-Event-Id")).isEqualTo("a:1");
  }

  @Test
  void aRefusedStreamThrowsWhenItsOpened() {
    handler = (ex, n) -> answer(ex, 404, "{\"error\":{\"code\":\"run-not-found\",\"message\":\"No run.\"}}");
    assertThatThrownBy(() -> client.runs().stream(RUN_ID)).isInstanceOf(NotFoundException.class);
  }

  @Test
  void anAsyncStreamPublishesEveryEvent() throws InterruptedException {
    handler = (ex, n) -> sse(ex, "id: a:1\ndata: " + event(1) + "\n\nid: a:2\ndata: " + event(2) + "\n\n", false);
    List<Long> sequences = new CopyOnWriteArrayList<>();
    CountDownLatch done = new CountDownLatch(1);
    client.async().runs().stream(RUN_ID).subscribe(new Flow.Subscriber<RunEvent>() {
      @Override
      public void onSubscribe(Flow.Subscription s) {
        s.request(Long.MAX_VALUE);
      }

      @Override
      public void onNext(RunEvent item) {
        sequences.add(item.sequence());
      }

      @Override
      public void onError(Throwable throwable) {
        done.countDown();
      }

      @Override
      public void onComplete() {
        done.countDown();
      }
    });
    assertThat(done.await(10, TimeUnit.SECONDS)).isTrue();
    assertThat(sequences).containsExactly(1L, 2L);
  }

  @Test
  void followReconnectsAfterTheServersTimeLimitUntilTheRunEnds() {
    // The server ends the first stream while the run goes on (its time limit); the second brings the end.
    handler = (ex, n) -> sse(ex, n == 1
        ? frame(1, "run.started") + frame(2, "run.step-completed")
        : frame(3, "run.completed"), false);
    List<String> kinds = new ArrayList<>();
    try (EventStream<RunEvent> events = client.runs().follow(RUN_ID)) {
      events.forEachRemaining(e -> kinds.add(e.kind().asString()));
    }
    assertThat(kinds).containsExactly("run.started", "run.step-completed", "run.completed");
    assertThat(seen).hasSize(2);
    assertThat(seen.get(0).header("Last-Event-Id")).isNull();
    assertThat(seen.get(1).header("Last-Event-Id")).isEqualTo("a:2");
    assertThat(seen.get(1).uri()).isEqualTo("/v1/runs/" + RUN_ID + "/stream");
  }

  @Test
  void followEndsAtTheTerminalEventEvenWhenTheServerKeepsTheStreamOpen() {
    CountDownLatch release = new CountDownLatch(1);
    handler = (ex, n) -> {
      ex.getResponseHeaders().set("Content-Type", "text/event-stream");
      ex.sendResponseHeaders(200, 0);
      OutputStream out = ex.getResponseBody();
      out.write((frame(1, "run.failed")).getBytes(StandardCharsets.UTF_8));
      out.flush();
      try {
        release.await(10, TimeUnit.SECONDS);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
      }
      out.close();
    };
    long started = System.nanoTime();
    try (EventStream<RunEvent> events = client.runs().follow(RUN_ID)) {
      assertThat(events.next().kind().asString()).isEqualTo("run.failed");
      assertThat(events.hasNext()).isFalse();
    } finally {
      release.countDown();
    }
    assertThat((System.nanoTime() - started) / 1_000_000L).isLessThan(3_000);
  }

  @Test
  void followPausesAfterAConnectionThatBroughtNothing() {
    handler = (ex, n) -> sse(ex, n == 1 ? ": keep-alive\n\n" : frame(1, "run.cancelled"), false);
    long started = System.nanoTime();
    try (EventStream<RunEvent> events = client.runs().follow(RUN_ID)) {
      assertThat(events.next().kind().asString()).isEqualTo("run.cancelled");
      assertThat(events.hasNext()).isFalse();
    }
    assertThat((System.nanoTime() - started) / 1_000_000L).isGreaterThanOrEqualTo(450);
    assertThat(seen).hasSize(2);
  }

  @Test
  void followDoesntRetryARefusedReconnect() {
    handler = (ex, n) -> {
      if (n == 1) {
        sse(ex, frame(1, "run.started"), false);
      } else {
        answer(ex, 401, "{\"error\":{\"code\":\"auth-invalid\",\"message\":\"Token expired.\"}}");
      }
    };
    try (EventStream<RunEvent> events = client.runs().follow(RUN_ID)) {
      assertThat(events.next().kind().asString()).isEqualTo("run.started");
      assertThatThrownBy(events::hasNext).isInstanceOf(AuthException.class);
    }
    assertThat(seen).hasSize(2);
  }

  @Test
  void followProgressFollowsTheProgressStream() {
    handler = (ex, n) -> sse(ex, n == 1
        ? "id: a:1\ndata: {\"eventId\":\"a:1\",\"runId\":\"" + RUN_ID + "\",\"timestamp\":\"2026-10-07T10:00:01Z\",\"kind\":\"run.started\",\"sequence\":1}\n\n"
        : "id: a:2\ndata: {\"eventId\":\"a:2\",\"runId\":\"" + RUN_ID + "\",\"timestamp\":\"2026-10-07T10:00:02Z\",\"kind\":\"run.completed\",\"sequence\":2}\n\n", false);
    List<String> kinds = new ArrayList<>();
    try (EventStream<RunProgressEvent> events = client.runs().followProgress(RUN_ID)) {
      events.forEachRemaining(e -> kinds.add(e.kind()));
    }
    assertThat(kinds).containsExactly("run.started", "run.completed");
    assertThat(seen.get(1).uri()).isEqualTo("/v1/runs/" + RUN_ID + "/progress/stream");
    assertThat(seen.get(1).header("Last-Event-Id")).isEqualTo("a:1");
  }

  @Test
  void anAsyncFollowPublishesThroughTheRunsEnd() throws InterruptedException {
    handler = (ex, n) -> sse(ex, n == 1 ? frame(1, "run.started") : frame(2, "run.completed"), false);
    List<String> kinds = new CopyOnWriteArrayList<>();
    CountDownLatch done = new CountDownLatch(1);
    client.async().runs().follow(RUN_ID).subscribe(new Flow.Subscriber<RunEvent>() {
      @Override
      public void onSubscribe(Flow.Subscription s) {
        s.request(Long.MAX_VALUE);
      }

      @Override
      public void onNext(RunEvent item) {
        kinds.add(item.kind().asString());
      }

      @Override
      public void onError(Throwable throwable) {
        done.countDown();
      }

      @Override
      public void onComplete() {
        done.countDown();
      }
    });
    assertThat(done.await(10, TimeUnit.SECONDS)).isTrue();
    assertThat(kinds).containsExactly("run.started", "run.completed");
  }
}
