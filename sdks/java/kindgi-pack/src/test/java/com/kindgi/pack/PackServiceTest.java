// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import static org.assertj.core.api.Assertions.assertThat;

import com.kindgi.pack.internal.HttpServer;
import com.kindgi.pack.internal.Json;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * The service in process, for what the conformance suite can't see from outside: the token is
 * checked before a body is read, late handlers are logged, and binding errors are issues.
 */
class PackServiceTest {
  private static final String TOKEN = "t0ken";
  private static final String TOOLS = "src/main/java/com/kindgi/pack/testpacks/service/Tools.java";
  private static final String CHECKS = "src/main/java/com/kindgi/pack/testpacks/service/Checks.java";

  private final List<Map<String, Object>> logs = new CopyOnWriteArrayList<>();
  private PackService service;
  private HttpServer server;
  private Thread acceptor;

  private static Map<String, Object> tool(String id) {
    Map<String, Object> t = new LinkedHashMap<>();
    t.put("id", id);
    t.put("version", "1.0.0");
    t.put("input", id.equals("acme.typed") ? Map.of("type", "object", "properties", Map.of("count", Map.of("type", "integer"))) : Map.of("type", "object"));
    t.put("output", Map.of("type", "object"));
    t.put("modulePath", TOOLS);
    return t;
  }

  @BeforeEach
  void start() throws IOException {
    Map<String, Object> index = new LinkedHashMap<>();
    index.put("v", 1);
    index.put("packId", "acme");
    index.put("packVersion", "1.0.0");
    index.put("artifactVersion", "20261001.7");
    List<Object> tools = new ArrayList<>();
    for (String id : List.of("acme.stubborn", "acme.polite", "acme.nan", "acme.typed", "acme.later", "acme.laterFails",
        "acme.laterNull", "acme.laterNever")) {
      tools.add(tool(id));
    }
    index.put("tools", tools);
    Map<String, Object> min = new LinkedHashMap<>();
    min.put("id", "acme.min");
    min.put("checkId", "acme.checks.min");
    min.put("kind", "zero-llm");
    min.put("action", Map.of("on-violation", "halt"));
    min.put("checkModulePath", CHECKS);
    min.put("configSchema", com.kindgi.pack.internal.SchemaDeriver.schema(com.kindgi.pack.testpacks.service.Checks.MinLength.class));
    Map<String, Object> broken = new LinkedHashMap<>(min);
    broken.put("id", "acme.broken");
    broken.put("checkId", "acme.min");
    broken.put("configSchema", Map.of("type", "object", "if", Map.of()));
    Map<String, Object> laterMin = new LinkedHashMap<>(min);
    laterMin.put("id", "acme.laterMin");
    laterMin.put("checkId", "acme.checks.laterMin");
    index.put("guardrails", List.of(min, broken, laterMin));
    assertThat(PackService.missingModules(index, getClass().getClassLoader())).isEmpty();
    service = new PackService(index, TOKEN, 4, "strict", Map.of(), logs::add);
    assertThat(service.prewarm(getClass().getClassLoader())).isEmpty();
    ServerSocket socket = new ServerSocket();
    socket.bind(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0));
    server = new HttpServer(socket, service, 16);
    acceptor = new Thread(server::serve, "test-acceptor");
    acceptor.start();
  }

  @AfterEach
  void stop() throws Exception {
    server.close();
    service.close();
    acceptor.join(2_000);
  }

  private String raw(String head, int readTimeoutMs) throws IOException {
    try (Socket s = new Socket(InetAddress.getLoopbackAddress(), server.port())) {
      s.setSoTimeout(readTimeoutMs);
      s.getOutputStream().write(head.getBytes(StandardCharsets.ISO_8859_1));
      s.getOutputStream().flush();
      InputStream in = s.getInputStream();
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      byte[] buf = new byte[4096];
      try {
        int n;
        while ((n = in.read(buf)) != -1) {
          out.write(buf, 0, n);
        }
      } catch (IOException e) {
        // Timed out after the answer: the server waits for the announced body.
      }
      return out.toString(StandardCharsets.UTF_8);
    }
  }

  @SuppressWarnings("unchecked")
  private Map<String, Object> invoke(String toolId, Object input, String timeoutMs) throws IOException {
    Map<String, Object> message = new LinkedHashMap<>();
    message.put("v", 2);
    message.put("kind", "invoke");
    message.put("tool", Map.of("id", toolId));
    message.put("input", input);
    message.put("ctx", Map.of("tenantId", "t1", "runId", "r1"));
    byte[] body = Json.compact(message);
    String response = raw("POST /v1/invoke HTTP/1.1\r\nkindgi-pack-token: " + TOKEN + "\r\ncontent-type: application/json\r\n"
        + (timeoutMs == null ? "" : "kindgi-timeout-ms: " + timeoutMs + "\r\n")
        + "content-length: " + body.length + "\r\n\r\n" + new String(body, StandardCharsets.ISO_8859_1), 10_000);
    assertThat(response).startsWith("HTTP/1.1 200 OK");
    return (Map<String, Object>) Json.parse(response.substring(response.indexOf("\r\n\r\n") + 4).getBytes(StandardCharsets.UTF_8));
  }

  @SuppressWarnings("unchecked")
  private Map<String, Object> check(String checkId, Object config) throws IOException {
    Map<String, Object> message = new LinkedHashMap<>();
    message.put("v", 2);
    message.put("kind", "check-invoke");
    message.put("check", Map.of("id", checkId));
    message.put("config", config);
    message.put("trace", Map.of("runId", "r1", "tenantId", "t1", "output", "hello", "toolCalls", List.of(),
        "toolResults", List.of(), "modelCalls", List.of(), "mode", "runtime"));
    byte[] body = Json.compact(message);
    String response = raw("POST /v1/invoke HTTP/1.1\r\nkindgi-pack-token: " + TOKEN + "\r\ncontent-type: application/json\r\n"
        + "content-length: " + body.length + "\r\n\r\n" + new String(body, StandardCharsets.ISO_8859_1), 10_000);
    assertThat(response).startsWith("HTTP/1.1 200 OK");
    return (Map<String, Object>) Json.parse(response.substring(response.indexOf("\r\n\r\n") + 4).getBytes(StandardCharsets.UTF_8));
  }

  @Test
  @SuppressWarnings("unchecked")
  void aChecksConfigIsCheckedAsSentThenItsDefaultsFilledIn() throws IOException {
    Map<String, Object> negative = check("acme.checks.min", Map.of("minLength", -1));
    assertThat(negative).containsEntry("code", "input-validation-failed").containsEntry("checkId", "acme.checks.min")
        .containsEntry("message", "Check \"acme.checks.min\" config failed validation at /minLength: must be >= 0");
    assertThat((List<Map<String, Object>>) negative.get("issues")).anySatisfy(i -> assertThat(i)
        .containsEntry("instancePath", "/minLength").containsEntry("keyword", "minimum"));
    Map<String, Object> wrongType = check("acme.checks.min", Map.of("minLength", "three"));
    assertThat((List<Map<String, Object>>) wrongType.get("issues")).anySatisfy(i -> assertThat(i)
        .containsEntry("instancePath", "/minLength").containsEntry("keyword", "type"));
    assertThat((String) check("acme.checks.min", Map.of("extra", 1)).get("message"))
        .isEqualTo("Check \"acme.checks.min\" config failed validation: must NOT have additional properties");
    // Left out, minLength is its default: the check ran with 1.
    assertThat(check("acme.checks.min", Map.of())).containsEntry("kind", "check-result")
        .containsEntry("result", Map.of("passed", true, "attributes", Map.of("minLength", 1)));
  }

  @Test
  void aConfigSchemaThatDoesntCompileIsSaid() throws IOException {
    Map<String, Object> answer = check("acme.min", Map.of());
    assertThat(answer).containsEntry("code", "input-validation-failed");
    assertThat((String) answer.get("message")).startsWith("Check \"acme.min\" config schema failed to compile: ");
  }

  @Test
  void theTokenIsCheckedBeforeABodyIsRead() throws IOException {
    // 50 MiB announced, none sent: the answers come at once, the body never read.
    long started = System.nanoTime();
    assertThat(raw("POST /v1/invoke HTTP/1.1\r\ncontent-type: application/json\r\ncontent-length: 52428800\r\n\r\n", 3_000))
        .startsWith("HTTP/1.1 401 Unauthorized");
    assertThat(raw("POST /v1/invoke HTTP/1.1\r\nkindgi-pack-token: " + TOKEN + "\r\ncontent-type: application/json\r\n"
        + "content-length: 52428800\r\n\r\n", 3_000)).startsWith("HTTP/1.1 413 ").contains("Request body too large");
    assertThat((System.nanoTime() - started) / 1_000_000L).isLessThan(2_500);
  }

  @Test
  void routeAndMethodComeBeforeTheToken() throws IOException {
    assertThat(raw("GET /v1/nope HTTP/1.1\r\n\r\n", 3_000)).startsWith("HTTP/1.1 404 ");
    assertThat(raw("GET /v1/invoke HTTP/1.1\r\n\r\n", 3_000)).startsWith("HTTP/1.1 405 ");
    assertThat(raw("POST /healthz HTTP/1.1\r\n\r\n", 3_000)).startsWith("HTTP/1.1 405 ");
    assertThat(raw("GET /v1/info HTTP/1.1\r\nkindgi-pack-token: " + TOKEN + "x\r\n\r\n", 3_000)).startsWith("HTTP/1.1 401 ");
  }

  @Test
  void whileDrainingCallsAre503BeforeAnythingElse() throws IOException {
    service.beginDrain();
    String response = raw("POST /v1/invoke HTTP/1.1\r\nkindgi-pack-token: " + TOKEN + "\r\ncontent-type: text/plain\r\n\r\n", 3_000);
    assertThat(response).startsWith("HTTP/1.1 503 ").contains("retry-after: 1").endsWith("{\"error\":\"draining\"}");
  }

  @Test
  void aHandlerThatIgnoresItsInterruptIsAnsweredAtTheDeadlineAndLoggedWhenItFinishes() throws Exception {
    Map<String, Object> answer = invoke("acme.stubborn", Map.of(), "50");
    assertThat(answer).containsEntry("code", "deadline-exceeded").containsEntry("toolId", "acme.stubborn");
    long until = System.nanoTime() + 3_000_000_000L;
    while (logs.stream().noneMatch(l -> "handler-finished-late".equals(l.get("kind"))) && System.nanoTime() < until) {
      Thread.sleep(20);
    }
    assertThat(logs).anySatisfy(l -> assertThat(l).containsEntry("kind", "handler-finished-late")
        .containsEntry("target", "tool").containsEntry("id", "acme.stubborn").containsKey("afterMs"));
  }

  @Test
  void aHandlerThatStopsWhenCancelledIsNotLate() throws Exception {
    Map<String, Object> answer = invoke("acme.polite", Map.of(), "50");
    assertThat(answer).containsEntry("code", "deadline-exceeded");
    Thread.sleep(300);
    assertThat(logs).noneSatisfy(l -> assertThat(l).containsEntry("kind", "handler-finished-late"));
    assertThat(logs).anySatisfy(l -> assertThat(l).containsEntry("kind", "call").containsEntry("outcome", "deadline-exceeded"));
  }

  @Test
  void anAsyncHandlerIsAwaited() throws Exception {
    assertThat(invoke("acme.later", Map.of("n", 1), null)).containsEntry("output", Map.of("echo", Map.of("n", 1)));
  }

  @Test
  void anAsyncHandlersFailureIsTheHandlersOwn() throws Exception {
    Map<String, Object> answer = invoke("acme.laterFails", Map.of(), null);
    assertThat(answer).containsEntry("code", "handler-throw");
    assertThat((String) answer.get("message")).isEqualTo(
        "Handler for tool \"acme.laterFails\" threw: java.lang.IllegalStateException: card declined");
  }

  @Test
  void anAsyncHandlerThatReturnsNoFutureIsAHandlerError() throws Exception {
    Map<String, Object> answer = invoke("acme.laterNull", Map.of(), null);
    assertThat(answer).containsEntry("code", "handler-throw");
    assertThat((String) answer.get("message")).contains("returned no CompletionStage");
  }

  @Test
  void anAsyncHandlerPastItsDeadlineHasItsFutureCancelledAndIsNotLate() throws Exception {
    Map<String, Object> answer = invoke("acme.laterNever", Map.of(), "50");
    assertThat(answer).containsEntry("code", "deadline-exceeded").containsEntry("toolId", "acme.laterNever");
    long until = System.nanoTime() + 3_000_000_000L;
    while (!com.kindgi.pack.testpacks.service.Tools.NEVER.get().isCancelled() && System.nanoTime() < until) {
      Thread.sleep(10);
    }
    assertThat(com.kindgi.pack.testpacks.service.Tools.NEVER.get().isCancelled()).isTrue();
    Thread.sleep(300);
    assertThat(logs).noneSatisfy(l -> assertThat(l).containsEntry("kind", "handler-finished-late"));
  }

  @Test
  void anAsyncCheckIsAwaited() throws Exception {
    assertThat(check("acme.checks.laterMin", Map.of("minLength", 9))).containsEntry("kind", "check-result")
        .containsEntry("result", Map.of("passed", false, "attributes", Map.of("minLength", 9)));
  }

  @Test
  void outputJsonCantWriteIsAnOutputError() throws Exception {
    Map<String, Object> answer = invoke("acme.nan", Map.of(), null);
    assertThat(answer).containsEntry("code", "output-validation-failed");
    assertThat((String) answer.get("message")).contains("not JSON").contains("NaN");
  }

  @Test
  @SuppressWarnings("unchecked")
  void whatTheInputTypeRefusesIsAnIssue() throws Exception {
    assertThat(invoke("acme.typed", Map.of("count", 2), null)).containsEntry("output", Map.of("count", 2));
    Map<String, Object> answer = invoke("acme.typed", Map.of("count", 13), null);
    assertThat(answer).containsEntry("code", "input-validation-failed");
    Map<String, Object> issue = ((List<Map<String, Object>>) answer.get("issues")).get(0);
    assertThat(issue).containsEntry("keyword", "binding").containsEntry("schemaPath", "#");
    assertThat((String) issue.get("message")).contains("unlucky");
  }

  @Test
  void theLauncherHandsTheTokenOverOutOfTheEnvironment() throws Exception {
    Path launcher = Path.of(PackService.class.getResource("kindgi-pack-java").toURI());
    String token = "a\\b$c`d'e\"f;g";
    ProcessBuilder pb = new ProcessBuilder("sh", launcher.toString(), "-cp", System.getProperty("java.class.path"),
        "com.kindgi.pack.LauncherProbe");
    pb.environment().put("JAVA_HOME", System.getProperty("java.home"));
    pb.environment().put("KINDGI_PACK_SERVICE_TOKEN", token + "\n");
    pb.redirectErrorStream(true);
    Process p = pb.start();
    String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    assertThat(p.waitFor()).as(out).isEqualTo(0);
    assertThat(out).contains("token=" + token + "\n").contains("inEnv=false");
  }

  @Test
  void serveConfigProblemsAreListed() {
    Object problems = Serve.readConfig(List.of("--index", "/x.json", "--verbose", "--host"),
        Map.of("KINDGI_PACK_SERVICE_TOKEN", "two words", "PORT", "http", "KINDGI_PACK_SERVICE_MAX_CONCURRENCY", "0",
            "KINDGI_PACK_ENV_CHECK", "loose"), null);
    @SuppressWarnings("unchecked")
    List<String> listed = (List<String>) problems;
    assertThat(listed).hasSize(6).anySatisfy(p -> assertThat(p).contains("unexpected argument --verbose"))
        .anySatisfy(p -> assertThat(p).contains("--host needs a value"))
        .anySatisfy(p -> assertThat(p).contains("printable ASCII"))
        .anySatisfy(p -> assertThat(p).contains("PORT must be a port number"))
        .anySatisfy(p -> assertThat(p).contains("MAX_CONCURRENCY"))
        .anySatisfy(p -> assertThat(p).contains("KINDGI_PACK_ENV_CHECK"));
    Object ok = Serve.readConfig(List.of(), Map.of("KINDGI_PACK_SERVICE_TOKEN", " x \n", "PORT", "0"), null);
    assertThat(ok).isEqualTo(new Serve.Config(Path.of("/app/index.json"), "x", 0, null, 32, "strict"));
  }
}
