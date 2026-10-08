// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import com.fasterxml.jackson.databind.JsonMappingException;
import com.kindgi.pack.internal.Defaults;
import com.kindgi.pack.internal.HttpServer;
import com.kindgi.pack.internal.Json;
import com.kindgi.pack.internal.SchemaValidator;
import java.io.EOFException;
import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.Type;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import org.jspecify.annotations.Nullable;

/**
 * The pack service: runs a Java pack's tool handlers and guardrail checks over pack protocol v2,
 * with the routes, statuses and messages of the TypeScript and Python pack services
 * ({@code @kindgi/specs/pack-protocol.schema.json}):
 *
 * <pre>
 * POST /v1/invoke   (token)  a v2 request → 200 with a v2 response
 * GET  /v1/info     (token)  the pack's identity, tools and checks
 * GET  /healthz              the process is up
 * GET  /readyz               every class loaded, not draining, and (under
 *                            KINDGI_PACK_ENV_CHECK=strict) every name in the
 *                            index's env.required set and non-empty
 * </pre>
 *
 * Every call runs on its own thread, up to a cap. When a call passes its deadline ({@code
 * kindgi-timeout-ms}) or the caller disconnects, the answer is {@code deadline-exceeded} or {@code
 * cancelled}, the handler's {@link Cancellation} fires and its thread is interrupted. What handlers
 * print goes to the process's own stdout and stderr, never into a response.
 */
final class PackService implements HttpServer.Handler {
  static final int PROTOCOL = 2;
  static final int DEFAULT_MAX_CONCURRENCY = 32;
  static final long DEFAULT_MAX_BODY_BYTES = 10L * 1024 * 1024;
  static final long DEFAULT_TIMEOUT_MS = 120_000;

  private static final Map<String, String[]> ROUTES = Map.of(
      "/v1/invoke", new String[] {"POST", "auth"},
      "/v1/info", new String[] {"GET", "auth"},
      "/healthz", new String[] {"GET", ""},
      "/readyz", new String[] {"GET", ""});

  /** A tool the index names, resolved to its definition. */
  private record ToolEntry(Map<String, Object> entry, Tool<?, ?> tool, Object input, Object output) {}

  /** A check the index names, resolved to its guardrail. */
  private record CheckEntry(Map<String, Object> entry, Guardrail<?> guardrail, @Nullable Object config) {}

  private final Map<String, Object> index;
  private final byte[] token;
  private final int maxConcurrency;
  private final long maxBodyBytes;
  private final String envCheck;
  private final List<String> missingEnv;
  private final Consumer<Map<String, Object>> log;
  /** Every version of a tool the pack holds, side by side, in index order. */
  private final Map<String, List<ToolEntry>> tools = new LinkedHashMap<>();
  private final Map<String, CheckEntry> checks = new LinkedHashMap<>();
  private final AtomicInteger inFlight = new AtomicInteger();
  private final ExecutorService calls;
  private volatile boolean ready;
  private volatile boolean draining;

  @SuppressWarnings("unchecked")
  PackService(
      Map<String, Object> index,
      String token,
      int maxConcurrency,
      String envCheck,
      Map<String, String> environ,
      Consumer<Map<String, Object>> log) {
    this.index = index;
    this.token = token.getBytes(StandardCharsets.UTF_8);
    this.maxConcurrency = maxConcurrency;
    this.maxBodyBytes = DEFAULT_MAX_BODY_BYTES;
    this.envCheck = envCheck;
    this.log = log;
    Object env = index.get("env");
    List<String> missing = new ArrayList<>();
    if (env instanceof Map) {
      Object required = ((Map<String, Object>) env).get("required");
      if (required instanceof List) {
        for (Object name : (List<Object>) required) {
          String value = environ.get(String.valueOf(name));
          if (value == null || value.isEmpty()) {
            missing.add(String.valueOf(name));
          }
        }
      }
    }
    this.missingEnv = List.copyOf(missing);
    AtomicInteger n = new AtomicInteger();
    this.calls = Executors.newCachedThreadPool(r -> {
      Thread t = new Thread(r, "kindgi-pack-call-" + n.incrementAndGet());
      t.setDaemon(true);
      return t;
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------------------------

  /**
   * {@code src/main/java/com/acme/tools/Greet.java} → its class name ({@code …Greet$}, the object,
   * for a Scala file); {@code null} for any other path.
   */
  static @Nullable String classOf(String modulePath) {
    if (modulePath.contains("..") || modulePath.contains("\\")) {
      return null;
    }
    return Indexer.className(modulePath);
  }

  /** The module paths of the index whose classes aren't on the classpath: {@code Missing module: <path>}. */
  @SuppressWarnings("unchecked")
  static List<String> missingModules(Map<String, Object> index, ClassLoader loader) {
    List<String> problems = new ArrayList<>();
    List<String> paths = new ArrayList<>();
    for (Object t : (List<Object>) index.getOrDefault("tools", List.of())) {
      paths.add(String.valueOf(((Map<String, Object>) t).get("modulePath")));
    }
    for (Object g : (List<Object>) index.getOrDefault("guardrails", List.of())) {
      paths.add(String.valueOf(((Map<String, Object>) g).get("checkModulePath")));
    }
    for (String path : paths) {
      String name = classOf(path);
      if (name == null || loader.getResource(name.replace('.', '/') + ".class") == null) {
        String problem = "Missing module: " + path;
        if (!problems.contains(problem)) {
          problems.add(problem);
        }
      }
    }
    return problems;
  }

  /**
   * Loads every tool and check class the index names and finds its definitions.
   *
   * @return the failures; empty when the service is ready
   */
  @SuppressWarnings("unchecked")
  List<String> prewarm(ClassLoader loader) {
    List<String> failures = new ArrayList<>();
    Map<String, List<Object>> loaded = new LinkedHashMap<>();
    String packVersion = String.valueOf(index.get("packVersion"));
    for (Object t : (List<Object>) index.getOrDefault("tools", List.of())) {
      Map<String, Object> entry = (Map<String, Object>) t;
      String id = String.valueOf(entry.get("id"));
      String path = String.valueOf(entry.get("modulePath"));
      List<Object> primitives = load(path, loader, loaded, id, failures);
      if (primitives == null) {
        continue;
      }
      Tool<?, ?> found = null;
      List<Tool<?, ?>> byId = new ArrayList<>();
      for (Object p : primitives) {
        if (p instanceof Tool && ((Tool<?, ?>) p).id().equals(id)) {
          byId.add((Tool<?, ?>) p);
        }
      }
      for (Tool<?, ?> tool : byId) {
        String version = tool.version() != null ? tool.version() : packVersion;
        if (byId.size() == 1 || Objects.equals(version, entry.get("version"))) {
          found = tool;
          break;
        }
      }
      if (found == null) {
        failures.add(id + ": " + path + " does not define tool \"" + id + "\"");
        continue;
      }
      tools.computeIfAbsent(id, k -> new ArrayList<>())
          .add(new ToolEntry(entry, found, validator(entry.get("input")), validator(entry.get("output"))));
    }
    for (Object g : (List<Object>) index.getOrDefault("guardrails", List.of())) {
      Map<String, Object> entry = (Map<String, Object>) g;
      String checkId = String.valueOf(entry.get("checkId") != null ? entry.get("checkId") : entry.get("id"));
      String path = String.valueOf(entry.get("checkModulePath"));
      List<Object> primitives = load(path, loader, loaded, checkId, failures);
      if (primitives == null) {
        continue;
      }
      Guardrail<?> found = null;
      for (Object p : primitives) {
        if (p instanceof Guardrail) {
          Guardrail<?> guardrail = (Guardrail<?>) p;
          if (checkId.equals(guardrail.checkId()) || checkId.equals(guardrail.id())) {
            found = guardrail;
            break;
          }
        }
      }
      if (found == null) {
        failures.add(checkId + ": " + path + " does not define check \"" + checkId + "\"");
        continue;
      }
      Object schema = entry.get("configSchema");
      checks.put(checkId, new CheckEntry(entry, found, schema instanceof Map ? validator(schema) : null));
    }
    ready = failures.isEmpty();
    return failures;
  }

  private static @Nullable List<Object> load(
      String path, ClassLoader loader, Map<String, List<Object>> loaded, String targetId, List<String> failures) {
    if (loaded.containsKey(path)) {
      return loaded.get(path);
    }
    String name = classOf(path);
    try {
      if (name == null) {
        throw new ClassNotFoundException(path);
      }
      List<Object> primitives = Indexer.primitivesOf(Class.forName(name, true, loader));
      loaded.put(path, primitives);
      return primitives;
    } catch (ExceptionInInitializerError e) {
      Throwable cause = e.getCause() == null ? e : e.getCause();
      failures.add(targetId + ": " + cause);
    } catch (ClassNotFoundException | LinkageError | RuntimeException e) {
      failures.add(targetId + ": " + e);
    }
    loaded.put(path, null);
    return null;
  }

  /** A validator for a schema, or the exception that says why there's none. */
  @SuppressWarnings("unchecked")
  private static Object validator(@Nullable Object schema) {
    try {
      return new SchemaValidator(schema instanceof Map ? (Map<String, Object>) schema : Map.of());
    } catch (RuntimeException e) {
      return e;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------

  Map<String, Object> index() {
    return index;
  }

  List<String> missingEnv() {
    return missingEnv;
  }

  int inFlight() {
    return inFlight.get();
  }

  /** Stops taking calls: {@code /readyz} and new calls answer 503. */
  void beginDrain() {
    draining = true;
  }

  /** Why {@code /readyz} and new calls answer 503; {@code null} when ready. */
  private @Nullable Map<String, Object> unready() {
    Map<String, Object> body = new LinkedHashMap<>();
    if (draining) {
      body.put("error", "draining");
    } else if (envCheck.equals("strict") && !missingEnv.isEmpty()) {
      body.put("error", "missing env");
      body.put("missingEnv", missingEnv);
    } else if (!ready) {
      body.put("error", "not ready");
    } else {
      return null;
    }
    return body;
  }

  // ---------------------------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------------------------

  @Override
  public void handle(HttpServer.Exchange ex) throws IOException {
    String[] route = ROUTES.get(ex.path());
    if (route == null) {
      ex.error(404, "No route " + ex.path());
      return;
    }
    if (!ex.method().equals(route[0])) {
      ex.error(405, "Use " + route[0]);
      return;
    }
    if (route[1].equals("auth") && !authorized(ex.header("kindgi-pack-token"))) {
      ex.error(401, "Bad pack token");
      return;
    }
    switch (ex.path()) {
      case "/healthz":
        ex.respond(200, Map.of(), Json.compact(Map.of("status", "ok")));
        return;
      case "/readyz": {
        Map<String, Object> unready = unready();
        if (unready == null) {
          ex.respond(200, Map.of(), Json.compact(Map.of("status", "ready")));
        } else {
          ex.respond(503, Map.of("retry-after", "1"), Json.compact(unready));
        }
        return;
      }
      case "/v1/info":
        ex.respond(200, Map.of(), Json.compact(info()));
        return;
      default:
        invoke(ex);
    }
  }

  private boolean authorized(@Nullable String got) {
    return got != null && MessageDigest.isEqual(got.getBytes(StandardCharsets.UTF_8), token);
  }

  private Map<String, Object> info() {
    List<Object> toolList = new ArrayList<>();
    tools.forEach((id, versions) -> {
      for (ToolEntry t : versions) {
        Map<String, Object> ref = new LinkedHashMap<>();
        ref.put("id", id);
        if (t.entry().get("version") instanceof String && !((String) t.entry().get("version")).isEmpty()) {
          ref.put("version", t.entry().get("version"));
        }
        toolList.add(ref);
      }
    });
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("protocol", PROTOCOL);
    out.put("packId", index.get("packId"));
    out.put("packVersion", index.get("packVersion"));
    out.put("artifactVersion", index.get("artifactVersion"));
    out.put("tools", toolList);
    out.put("checks", new ArrayList<>(checks.keySet()));
    out.put("missingEnv", missingEnv);
    return out;
  }

  private void invoke(HttpServer.Exchange ex) throws IOException {
    Map<String, Object> unready = unready();
    if (unready != null) {
      ex.respond(503, Map.of("retry-after", "1"), Json.compact(unready));
      return;
    }
    if (!tryAcquire()) {
      ex.respond(503, Map.of("retry-after", "1"), Json.compact(Map.of("error", "overloaded")));
      return;
    }
    try {
      String contentType = ex.header("content-type");
      if (contentType == null || !contentType.contains("application/json")) {
        ex.error(415, "Content-Type must be application/json");
        return;
      }
      if (ex.contentLength() > maxBodyBytes) {
        ex.error(413, "Request body too large");
        return;
      }
      long started = System.nanoTime();
      byte[] body;
      try {
        body = ex.body();
      } catch (EOFException e) {
        return;
      }
      Map<String, Object> response = dispatch(ex, body, started);
      if (response == null) {
        return;
      }
      Map<String, String> headers = new LinkedHashMap<>();
      headers.put("kindgi-duration-ms", String.valueOf((System.nanoTime() - started) / 1_000_000L));
      headers.put("kindgi-artifact-version", String.valueOf(index.getOrDefault("artifactVersion", "")));
      ex.respond(200, headers, Json.compact(response));
    } finally {
      inFlight.decrementAndGet();
    }
  }

  private boolean tryAcquire() {
    while (true) {
      int n = inFlight.get();
      if (n >= maxConcurrency) {
        return false;
      }
      if (inFlight.compareAndSet(n, n + 1)) {
        return true;
      }
    }
  }

  /** The response to a request body; {@code null} when the caller went away (and nothing is answered). */
  @SuppressWarnings("unchecked")
  private @Nullable Map<String, Object> dispatch(HttpServer.Exchange ex, byte[] body, long started) {
    Object value;
    try {
      value = Json.parse(body);
    } catch (IOException | RuntimeException e) {
      return error("malformed-message", "Request body is not valid JSON", null);
    }
    Object parsed = Requests.parse(value);
    if (parsed instanceof Map) {
      return (Map<String, Object>) parsed;
    }
    Requests.Call request = (Requests.Call) parsed;
    String target = request.tool() ? "tool" : "check";
    long timeoutMs = timeout(ex.header("kindgi-timeout-ms"));
    Cancellation cancellation = new Cancellation();
    Call call = new Call(ex, target, request.id(), started);
    calls.execute(() -> call.run(() -> request.tool()
        ? runTool(request, cancellation)
        : runCheck(request)));
    HttpServer.Wait wait = ex.await(call.outcome::isDone, started + timeoutMs * 1_000_000L);
    Map<String, Object> outcome;
    if (wait == HttpServer.Wait.DONE) {
      outcome = call.outcome.join();
    } else {
      String reason = wait == HttpServer.Wait.DEADLINE ? "deadline-exceeded" : "cancelled";
      cancellation.cancel(reason);
      call.abandon();
      outcome = error(reason, request.id() + (reason.equals("deadline-exceeded") ? " passed its deadline" : " was cancelled"),
          Map.of(request.tool() ? "toolId" : "checkId", request.id()));
    }
    Map<String, Object> line = new LinkedHashMap<>();
    line.put("kind", "call");
    line.put("target", target);
    line.put("id", request.id());
    line.put("durationMs", (System.nanoTime() - started) / 1_000_000L);
    line.put("outcome", "error".equals(outcome.get("kind")) ? outcome.get("code") : "ok");
    log.accept(line);
    return wait == HttpServer.Wait.DISCONNECTED ? null : outcome;
  }

  static long timeout(@Nullable String raw) {
    if (raw == null || raw.isBlank() || raw.strip().length() > 12 || !raw.strip().chars().allMatch(c -> c >= '0' && c <= '9')) {
      return DEFAULT_TIMEOUT_MS;
    }
    long ms = Long.parseLong(raw.strip());
    return ms > 0 ? ms : DEFAULT_TIMEOUT_MS;
  }

  /** One call's handler, on its own thread: its outcome, or a late finish once it's been answered without it. */
  private final class Call {
    final CompletableFuture<Map<String, Object>> outcome = new CompletableFuture<>();
    private final HttpServer.Exchange ex;
    private final String target;
    private final String id;
    private final long started;
    private volatile @Nullable Thread thread;
    private volatile boolean abandoned;

    Call(HttpServer.Exchange ex, String target, String id, long started) {
      this.ex = ex;
      this.target = target;
      this.id = id;
      this.started = started;
    }

    interface Body {
      Map<String, Object> run() throws InterruptedException;
    }

    void run(Body body) {
      thread = Thread.currentThread();
      boolean honoured = false;
      try {
        outcome.complete(body.run());
      } catch (InterruptedException | Cancellation.CancelledException e) {
        honoured = true;
        outcome.complete(error("cancelled", id + " was cancelled", Map.of(target.equals("tool") ? "toolId" : "checkId", id)));
      } catch (Throwable e) {
        outcome.complete(error("handler-throw", id + " failed: " + e, Map.of(target.equals("tool") ? "toolId" : "checkId", id)));
      } finally {
        thread = null;
        Thread.interrupted();
        ex.wake();
        if (abandoned && !honoured && !cancelledOutcome()) {
          Map<String, Object> line = new LinkedHashMap<>();
          line.put("kind", "handler-finished-late");
          line.put("target", target);
          line.put("id", id);
          line.put("afterMs", (System.nanoTime() - started) / 1_000_000L);
          log.accept(line);
        }
      }
    }

    private boolean cancelledOutcome() {
      Map<String, Object> o = outcome.getNow(null);
      return o != null && "cancelled".equals(o.get("code"));
    }

    /** The call was answered without the handler: stop it. */
    void abandon() {
      abandoned = true;
      Thread t = thread;
      if (t != null) {
        t.interrupt();
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Running pack code
  // ---------------------------------------------------------------------------------------------

  @SuppressWarnings({"unchecked", "rawtypes"})
  private Map<String, Object> runTool(Requests.Call request, Cancellation cancellation) throws InterruptedException {
    String toolId = request.id();
    Map<String, Object> ids = Map.of("toolId", toolId);
    List<ToolEntry> versions = tools.getOrDefault(toolId, List.of());
    if (versions.isEmpty()) {
      return error("tool-not-in-pack", "This pack has no tool \"" + toolId + "\"", ids);
    }
    ToolEntry entry = null;
    if (request.version() == null) {
      entry = versions.size() == 1 ? versions.get(0) : null;
    } else {
      for (ToolEntry t : versions) {
        if (request.version().equals(t.entry().get("version"))) {
          entry = t;
        }
      }
    }
    if (entry == null) {
      List<String> have = new ArrayList<>();
      for (ToolEntry t : versions) {
        Object v = t.entry().get("version");
        have.add(v == null || "".equals(v) ? "unversioned" : String.valueOf(v));
      }
      String asked = request.version() == null ? "named none" : "asked for " + request.version();
      return error("tool-version-mismatch",
          "Tool \"" + toolId + "\" is " + String.join(", ", have) + " in this pack; the caller " + asked, ids);
    }
    if (entry.input() instanceof RuntimeException) {
      return error("input-validation-failed",
          "Tool \"" + toolId + "\" input schema failed to compile: " + ((RuntimeException) entry.input()).getMessage(), ids);
    }
    // As the TypeScript service's Ajv useDefaults: the schema's defaults, filled into a copy.
    Object candidate = Defaults.apply((Map<String, Object>) entry.entry().get("input"), request.input());
    List<Map<String, Object>> issues = ((SchemaValidator) entry.input()).issues(candidate);
    if (!issues.isEmpty()) {
      return error("input-validation-failed", "Tool \"" + toolId + "\" input failed validation", with(ids, "issues", issues));
    }
    Object argument;
    try {
      argument = bind(candidate, entry.tool().inputType());
    } catch (IllegalArgumentException e) {
      return error("input-validation-failed", "Tool \"" + toolId + "\" input failed validation",
          with(ids, "issues", List.of(bindingIssue(e))));
    }
    ToolContext ctx = Requests.context(request.ctx(), cancellation);
    Object result;
    try {
      result = ((ToolHandler) entry.tool().handler()).handle(argument, ctx);
    } catch (InterruptedException e) {
      throw e;
    } catch (Cancellation.CancelledException e) {
      if (cancellation.isCancelled()) {
        throw e;
      }
      return error("handler-throw", "Handler for tool \"" + toolId + "\" threw: " + e, with(ids, "cause", cause(e)));
    } catch (Exception | LinkageError | AssertionError | StackOverflowError e) {
      return error("handler-throw", "Handler for tool \"" + toolId + "\" threw: " + e, with(ids, "cause", cause(e)));
    }
    Object output;
    try {
      output = Json.unbind(result);
      Json.requireFinite(output);
    } catch (IllegalArgumentException e) {
      return error("output-validation-failed",
          "Tool \"" + toolId + "\" handler produced output that is not JSON: " + e.getMessage(), ids);
    }
    if (entry.output() instanceof RuntimeException) {
      return error("output-validation-failed",
          "Tool \"" + toolId + "\" output schema failed to compile: " + ((RuntimeException) entry.output()).getMessage(), ids);
    }
    List<Map<String, Object>> outputIssues = ((SchemaValidator) entry.output()).issues(output);
    if (!outputIssues.isEmpty()) {
      return error("output-validation-failed",
          "Tool \"" + toolId + "\" handler produced output that failed validation", with(ids, "issues", outputIssues));
    }
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("v", PROTOCOL);
    out.put("kind", "result");
    out.put("output", output);
    return out;
  }

  @SuppressWarnings({"unchecked", "rawtypes"})
  private Map<String, Object> runCheck(Requests.Call request) throws InterruptedException {
    String checkId = request.id();
    Map<String, Object> ids = Map.of("checkId", checkId);
    CheckEntry entry = checks.get(checkId);
    if (entry == null) {
      return error("check-not-in-pack", "This pack has no check \"" + checkId + "\"", ids);
    }
    // The config is checked as sent, before the check runs; the schema's defaults are filled in
    // after, for the config type (as the TypeScript and Python services do).
    Object config = request.config();
    if (entry.config() instanceof RuntimeException) {
      return error("input-validation-failed",
          "Check \"" + checkId + "\" config schema failed to compile: " + ((RuntimeException) entry.config()).getMessage(), ids);
    }
    if (entry.config() instanceof SchemaValidator) {
      List<Map<String, Object>> issues = ((SchemaValidator) entry.config()).issues(config);
      if (!issues.isEmpty()) {
        return error("input-validation-failed", "Check \"" + checkId + "\" config failed validation" + firstIssue(issues),
            with(ids, "issues", issues));
      }
      config = Defaults.apply((Map<String, Object>) entry.entry().get("configSchema"), config);
    }
    Object bound;
    try {
      bound = bind(config, entry.guardrail().configType());
    } catch (IllegalArgumentException e) {
      List<Map<String, Object>> issues = List.of(bindingIssue(e));
      return error("input-validation-failed", "Check \"" + checkId + "\" config failed validation" + firstIssue(issues),
          with(ids, "issues", issues));
    }
    if (!(request.trace() instanceof Map)) {
      Map<String, Object> issue = new LinkedHashMap<>();
      issue.put("instancePath", "");
      issue.put("schemaPath", "#/type");
      issue.put("keyword", "type");
      issue.put("params", Map.of("type", "object"));
      issue.put("message", "must be object");
      return error("input-validation-failed", "Check \"" + checkId + "\" trace failed validation",
          with(ids, "issues", List.of(issue)));
    }
    RunTrace trace = new RunTrace((Map<String, Object>) request.trace());
    CheckResult result;
    try {
      result = ((CheckHandler) entry.guardrail().handler()).check(bound, trace);
    } catch (InterruptedException e) {
      throw e;
    } catch (Exception | LinkageError | AssertionError | StackOverflowError e) {
      return error("handler-throw", "Check \"" + checkId + "\" check() threw: " + e, with(ids, "cause", cause(e)));
    }
    if (result == null) {
      return error("output-validation-failed", "Check \"" + checkId + "\" returned null; a check returns a CheckResult", ids);
    }
    Map<String, Object> wire = new LinkedHashMap<>();
    wire.put("passed", result.passed());
    if (result.reason() != null) {
      wire.put("reason", result.reason());
    }
    if (result.judgeResponse() != null) {
      wire.put("judgeResponse", result.judgeResponse());
    }
    if (result.attributes() != null) {
      Object attributes;
      try {
        attributes = Json.unbind(result.attributes());
        Json.requireFinite(attributes);
      } catch (IllegalArgumentException e) {
        return error("output-validation-failed",
            "Check \"" + checkId + "\" returned attributes that are not JSON: " + e.getMessage(), ids);
      }
      wire.put("attributes", attributes);
    }
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("v", PROTOCOL);
    out.put("kind", "check-result");
    out.put("result", wire);
    return out;
  }

  /**
   * Where the first issue is and what it says ({@code " at /maxChars: must be > 0"}): a runtime
   * reports a check's error by its code and message alone.
   */
  static String firstIssue(List<Map<String, Object>> issues) {
    if (issues.isEmpty()) {
      return "";
    }
    Map<String, Object> first = issues.get(0);
    Object at = first.get("instancePath");
    Object message = first.get("message");
    return (at == null || "".equals(at) ? "" : " at " + at) + ": " + (message == null ? "invalid" : message);
  }

  /** A JSON value as the handler's type: a {@code Map} stays one, a record is bound by Jackson. */
  private static Object bind(Object value, Type type) {
    if (type == Map.class || type == Object.class) {
      return value;
    }
    return Json.bind(value, type);
  }

  /** An Ajv-shaped issue for what Jackson refused (an app's own annotations, a custom deserializer). */
  private static Map<String, Object> bindingIssue(IllegalArgumentException e) {
    StringBuilder pointer = new StringBuilder();
    String message = e.getMessage();
    Throwable cause = e.getCause();
    if (cause instanceof JsonMappingException) {
      JsonMappingException mapping = (JsonMappingException) cause;
      for (JsonMappingException.Reference ref : mapping.getPath()) {
        pointer.append('/').append(ref.getFieldName() != null
            ? ref.getFieldName().replace("~", "~0").replace("/", "~1")
            : String.valueOf(ref.getIndex()));
      }
      message = mapping.getOriginalMessage();
    }
    Map<String, Object> issue = new LinkedHashMap<>();
    issue.put("instancePath", pointer.toString());
    issue.put("schemaPath", "#");
    issue.put("keyword", "binding");
    issue.put("params", Map.of());
    issue.put("message", String.valueOf(message));
    return issue;
  }

  static Map<String, Object> error(String code, String message, @Nullable Map<String, Object> extra) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("v", PROTOCOL);
    out.put("kind", "error");
    out.put("code", code);
    out.put("message", message);
    if (extra != null) {
      extra.forEach((k, v) -> {
        if (v != null) {
          out.put(k, v);
        }
      });
    }
    return out;
  }

  private static Map<String, Object> with(Map<String, Object> ids, String key, Object value) {
    Map<String, Object> out = new LinkedHashMap<>(ids);
    out.put(key, value);
    return out;
  }

  static Map<String, Object> cause(Throwable e) {
    StringWriter stack = new StringWriter();
    e.printStackTrace(new PrintWriter(stack));
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("name", e.getClass().getName());
    out.put("message", String.valueOf(e.getMessage()));
    out.put("stack", stack.toString());
    return out;
  }

  /** For the shutdown: nothing left to run. */
  void close() {
    calls.shutdownNow();
  }
}
