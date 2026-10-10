// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import com.kindgi.pack.internal.HttpServer;
import com.kindgi.pack.internal.Json;
import java.io.IOException;
import java.io.InputStream;
import java.io.PrintStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * The pack service process: {@code com.kindgi.pack.Main serve [--index <path>] [--module-root
 * <dir>] [--host <address>]}, best started through the launcher ({@code kindgi-pack-java}), which
 * hands the service its token on file descriptor 3 rather than in the environment.
 *
 * <p>The process contract of the TypeScript and Python pack services, so the same supervisor
 * ({@code kindgi dev}) and the same deployment run any of them:
 *
 * <ul>
 *   <li>index: {@code --index}, else {@code KINDGI_PACK_INDEX}, else {@code /app/index.json}
 *   <li>module root: {@code --module-root}, accepted for the contract's sake; a Java pack's
 *       modules are the classes on the classpath
 *   <li>token: on the file descriptor in {@code -Dkindgi.pack.tokenFd} (the launcher's), else
 *       {@code KINDGI_PACK_SERVICE_TOKEN} (required)
 *   <li>concurrency: {@code KINDGI_PACK_SERVICE_MAX_CONCURRENCY} (default 32)
 *   <li>port: {@code PORT} (default 8080; {@code 0} picks one)
 *   <li>host: {@code --host}, else every interface
 *   <li>env check: {@code KINDGI_PACK_ENV_CHECK}, {@code strict} (default) or {@code warn}
 * </ul>
 *
 * Logs are {@code com.kindgi.log} records on stderr (subsystem {@code pack}), at {@code
 * KINDGI_LOG_LEVEL} / {@code KINDGI_LOG_LEVELS}, in {@code KINDGI_LOG_FORMAT} ({@code auto}: JSON
 * unless the process has a terminal): a record per call, and the lifecycle ({@code listening},
 * {@code boot-failed}, {@code draining}, …) whatever the levels ({@link PackLogs}). A bad log
 * setting is a {@code config-invalid} record and exit 1.
 *
 * <p>Boot fails (exit 1, a {@code boot-failed} record listing every problem) when the index can't be
 * read, a class it names isn't on the classpath, or one fails to load. Once listening it writes a
 * {@code listening} record with the bound port, for callers that start it with {@code PORT=0}.
 * SIGTERM drains in-flight calls ({@code /readyz} and new calls answer 503) for up to 8 s, then exits
 * 0.
 */
final class Serve {
  /** How long SIGTERM lets in-flight calls finish (Cloud Run allows 10 s from SIGTERM to SIGKILL). */
  static final long DRAIN_MS = 8_000;

  private static final Pattern TOKEN = Pattern.compile("[\\x21-\\x7e]+");

  private Serve() {}

  /**
   * The configuration.
   *
   * @param index the pack index
   * @param token the service token
   * @param port the port ({@code 0}: any free one)
   * @param host the address to listen on; {@code null} for every interface
   * @param maxConcurrency calls run at once
   * @param envCheck {@code strict} or {@code warn}
   */
  record Config(Path index, String token, int port, @Nullable String host, int maxConcurrency, String envCheck) {}

  static int main(List<String> argv, PrintStream err) {
    // The process has a terminal (Java 17 can't ask about stderr alone): a supervisor's pipes never do.
    PackLogs.Outcome built = PackLogs.fromEnv(System.getenv(), PackLogs::stderr, System.console() != null);
    if (built instanceof PackLogs.Err) {
      String message = ((PackLogs.Err) built).message();
      PackLogs.defaults().event(PackLogs.Event.CONFIG_INVALID, message, Map.of("problems", List.of(message)));
      return 1;
    }
    PackLogs logs = ((PackLogs.Ok) built).logs();
    for (String problem : ((PackLogs.Ok) built).problems()) {
      logs.log().warn(problem);
    }
    Object config = readConfig(argv, System.getenv(), System.getProperty("kindgi.pack.tokenFd"));
    if (config instanceof List) {
      logs.event(PackLogs.Event.CONFIG_INVALID, "The pack service configuration is invalid", Map.of("problems", config));
      return 1;
    }
    Config c = (Config) config;
    ClassLoader loader = Thread.currentThread().getContextClassLoader();
    Object service = load(c, System.getenv(), loader, logs);
    if (service instanceof List) {
      logs.event(PackLogs.Event.BOOT_FAILED, "The pack service failed to boot", Map.of("problems", service));
      return 1;
    }
    serve(c, (PackService) service, logs);
    return 0;
  }

  /** The configuration, or every problem with it. */
  static Object readConfig(List<String> argv, Map<String, String> env, @Nullable String tokenFd) {
    List<String> problems = new ArrayList<>();
    Map<String, String> args = new LinkedHashMap<>();
    for (int i = 0; i < argv.size(); i++) {
      String arg = argv.get(i);
      if (arg.equals("--index") || arg.equals("--module-root") || arg.equals("--host")) {
        if (i + 1 < argv.size() && !argv.get(i + 1).isEmpty()) {
          args.put(arg, argv.get(++i));
        } else {
          problems.add(arg + " needs a value");
        }
      } else {
        problems.add("unexpected argument " + arg);
      }
    }
    String indexArg = args.getOrDefault("--index", env.getOrDefault("KINDGI_PACK_INDEX", ""));
    Path index = Path.of(indexArg.isEmpty() ? "/app/index.json" : indexArg).toAbsolutePath().normalize();
    String token;
    if (tokenFd != null) {
      try {
        token = readToken(tokenFd);
      } catch (IOException | IllegalArgumentException e) {
        problems.add("Cannot read the service token from file descriptor " + tokenFd + ": " + e.getMessage());
        token = "";
      }
    } else {
      token = env.getOrDefault("KINDGI_PACK_SERVICE_TOKEN", "");
    }
    // Read as the server reads it: without surrounding whitespace (it travels in an HTTP header,
    // which never carries any).
    token = token.strip();
    if (token.isEmpty()) {
      if (problems.stream().noneMatch(p -> p.startsWith("Cannot read the service token"))) {
        problems.add("KINDGI_PACK_SERVICE_TOKEN is required");
      }
    } else if (!TOKEN.matcher(token).matches()) {
      problems.add("KINDGI_PACK_SERVICE_TOKEN may hold only printable ASCII without spaces (it travels in an"
          + " HTTP header). Use a random value such as `openssl rand -hex 32`.");
    }
    String rawPort = env.getOrDefault("PORT", "8080");
    int port = rawPort.matches("[0-9]{1,5}") ? Integer.parseInt(rawPort) : -1;
    if (port < 0 || port > 65535) {
      problems.add("PORT must be a port number, got " + Json.compactString(rawPort));
    }
    String rawConcurrency = env.get("KINDGI_PACK_SERVICE_MAX_CONCURRENCY");
    int maxConcurrency = PackService.DEFAULT_MAX_CONCURRENCY;
    if (rawConcurrency != null) {
      maxConcurrency = rawConcurrency.matches("[0-9]{1,6}") ? Integer.parseInt(rawConcurrency) : 0;
      if (maxConcurrency < 1) {
        problems.add("KINDGI_PACK_SERVICE_MAX_CONCURRENCY must be a positive integer");
      }
    }
    String envCheck = env.getOrDefault("KINDGI_PACK_ENV_CHECK", "");
    if (envCheck.isEmpty()) {
      envCheck = "strict";
    }
    if (!envCheck.equals("strict") && !envCheck.equals("warn")) {
      problems.add("KINDGI_PACK_ENV_CHECK must be `strict` or `warn`, not " + Json.compactString(envCheck));
    }
    if (!problems.isEmpty()) {
      return problems;
    }
    return new Config(index, token, port, args.get("--host"), maxConcurrency, envCheck);
  }

  /** The token the launcher wrote on a file descriptor: read once (a pipe, so nothing is left to read). */
  private static String readToken(String fd) throws IOException {
    if (!fd.matches("[0-9]{1,4}")) {
      throw new IllegalArgumentException("not a file descriptor: " + fd);
    }
    try (InputStream in = Files.newInputStream(Path.of("/dev/fd/" + fd))) {
      byte[] bytes = in.readNBytes(64 * 1024);
      return new String(bytes, StandardCharsets.UTF_8);
    }
  }

  /** Reads the index, loads every class it names; the service, or the problems. */
  @SuppressWarnings("unchecked")
  static Object load(Config config, Map<String, String> environ, ClassLoader loader, PackLogs logs) {
    Map<String, Object> index;
    try {
      Object parsed = Json.parse(Files.readAllBytes(config.index()));
      if (!(parsed instanceof Map)) {
        return List.of("Cannot read the pack index: " + config.index() + " doesn't hold a JSON object");
      }
      index = (Map<String, Object>) parsed;
    } catch (IOException | RuntimeException e) {
      return List.of("Cannot read the pack index: " + e);
    }
    Object v = index.get("v");
    if (!(v instanceof Number) || ((Number) v).doubleValue() != Indexer.INDEX_ENVELOPE_VERSION) {
      return List.of("Index envelope v" + v + " is not v1");
    }
    List<String> missing = PackService.missingModules(index, loader);
    if (!missing.isEmpty()) {
      return missing;
    }
    Map<String, Object> pack = new LinkedHashMap<>();
    pack.put("packId", index.get("packId"));
    pack.put("artifactVersion", index.get("artifactVersion"));
    // Logs a missing variable before the classes load: it's often why one fails.
    PackService service = new PackService(
        index, config.token(), config.maxConcurrency(), config.envCheck(), environ, logs.log().child(pack));
    List<String> failures = service.prewarm(loader);
    if (!failures.isEmpty()) {
      return failures;
    }
    return service;
  }

  static void serve(Config config, PackService service, PackLogs logs) {
    HttpServer server;
    try {
      ServerSocket socket = new ServerSocket();
      socket.setReuseAddress(true);
      InetAddress address = config.host() == null ? null : InetAddress.getByName(config.host());
      socket.bind(new InetSocketAddress(address, config.port()), 1024);
      server = new HttpServer(socket, service, Math.max(64, config.maxConcurrency() * 4));
    } catch (IOException e) {
      logs.event(PackLogs.Event.BOOT_FAILED, "The pack service failed to boot", Map.of("problems",
          List.of("Cannot listen on " + (config.host() == null ? "" : config.host()) + ":" + config.port() + ": " + e.getMessage())));
      System.exit(1);
      return;
    }
    Map<String, Object> listening = new LinkedHashMap<>();
    listening.put("port", server.port());
    listening.put("packId", service.index().get("packId"));
    listening.put("artifactVersion", service.index().get("artifactVersion"));
    HttpServer running = server;
    Runtime.getRuntime().addShutdownHook(new Thread(() -> drainThenHalt(running, service, logs), "kindgi-pack-drain"));
    logs.event(PackLogs.Event.LISTENING, "Listening on port " + server.port(), listening);
    server.serve();
  }

  /**
   * Stops taking calls, then says so. In that order: a supervisor that reads the {@code draining}
   * record and asks {@code /readyz} at once must get 503. The shutdown hook runs on its own thread,
   * beside the server's, so a record written first left a moment in which readyz still answered 200.
   */
  static void beginDraining(PackService service, PackLogs logs) {
    service.beginDrain();
    logs.event(PackLogs.Event.DRAINING, "Draining: finishing the calls in flight");
  }

  /** SIGTERM (or SIGINT): stop taking calls, let in-flight ones finish for up to 8 s, exit 0. */
  private static void drainThenHalt(HttpServer server, PackService service, PackLogs logs) {
    beginDraining(service, logs);
    long deadline = System.nanoTime() + DRAIN_MS * 1_000_000L;
    while (service.inFlight() > 0 && System.nanoTime() < deadline) {
      try {
        Thread.sleep(25);
      } catch (InterruptedException e) {
        break;
      }
    }
    try {
      server.close();
    } catch (IOException e) {
      // Closing anyway.
    }
    service.close();
    logs.event(PackLogs.Event.STOPPED, "Stopped");
    System.out.flush();
    // A drain is a clean stop: exit 0, not the JVM's 143 for SIGTERM.
    Runtime.getRuntime().halt(0);
  }
}
