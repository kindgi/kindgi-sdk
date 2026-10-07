// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.internal;

import com.kindgi.client.EventStream;
import com.kindgi.client.KindgiApiException;
import com.kindgi.client.NetworkException;
import com.kindgi.client.models.Model;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.Flow;
import java.util.concurrent.SubmissionPublisher;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.jspecify.annotations.Nullable;
import tools.jackson.core.exc.StreamReadException;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.DatabindException;
import tools.jackson.databind.JavaType;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * One request, its retries, and its answer: what every generated resource method calls.
 *
 * <ul>
 *   <li>{@code Authorization: Bearer <token>} on every call.
 *   <li>An operation that takes an {@code Idempotency-Key} gets one generated when the caller
 *       passes none, so a retry can never run it twice.
 *   <li>Retries: a connection error or timeout, or 429 / 502 / 503 / 504, only for a call that's
 *       safe to repeat (a GET, or one with an idempotency key), with exponential backoff that
 *       honours {@code Retry-After}.
 *   <li>A 2xx answer is read into the operation's model; anything else throws a typed {@link
 *       KindgiApiException}.
 *   <li>A stream ({@code text/event-stream}) reconnects with {@code Last-Event-Id} after a drop
 *       (backoff 0.5 s → 30 s, up to 10 attempts) and ends when the server closes it.
 * </ul>
 *
 * The same rules as the Python client's transport.
 */
public final class Transport {
  /** How long a call may take before it's retried or fails. */
  public static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(60);
  /** Retries after the first attempt. */
  public static final int DEFAULT_MAX_RETRIES = 2;
  static final Set<Integer> RETRY_STATUSES = Set.of(429, 502, 503, 504);
  static final int STREAM_ATTEMPTS = 10;

  private final String baseUrl;
  private final String token;
  private final Duration timeout;
  private final int maxRetries;
  private final Map<String, String> defaultHeaders;
  private final HttpClient http;
  private final ObjectMapper mapper;

  /**
   * @param baseUrl the runtime's URL
   * @param token the API token
   * @param timeout a call's timeout
   * @param maxRetries retries after the first attempt
   * @param defaultHeaders headers sent with every call
   * @param http the HTTP client, or {@code null} for a new one
   */
  public Transport(
      String baseUrl, String token, Duration timeout, int maxRetries, Map<String, String> defaultHeaders, @Nullable HttpClient http) {
    this.baseUrl = stripSlash(Objects.requireNonNull(baseUrl, "baseUrl"));
    this.token = Objects.requireNonNull(token, "token");
    this.timeout = Objects.requireNonNull(timeout, "timeout");
    if (maxRetries < 0) {
      throw new IllegalArgumentException("maxRetries must be at least 0");
    }
    this.maxRetries = maxRetries;
    this.defaultHeaders = Map.copyOf(defaultHeaders);
    this.http = http != null ? http : HttpClient.newBuilder().connectTimeout(timeout).followRedirects(HttpClient.Redirect.NORMAL).build();
    this.mapper = Json.mapper();
  }

  private static String stripSlash(String url) {
    String out = url;
    while (out.endsWith("/")) {
      out = out.substring(0, out.length() - 1);
    }
    return out;
  }

  /** @return the runtime's URL */
  public String baseUrl() {
    return baseUrl;
  }

  // ---------------------------------------------------------------------------------------------
  // Synchronous
  // ---------------------------------------------------------------------------------------------

  /**
   * @param <T> the answer's type
   * @param request the call
   * @param type the answer's type
   * @return the answer
   */
  public <T> T json(RequestSpec request, Class<T> type) {
    return parse(request.operation, send(prepare(request)), mapper.constructType(type));
  }

  /**
   * @param <T> the answer's type
   * @param request the call
   * @param type the answer's (generic) type
   * @return the answer
   */
  public <T> T json(RequestSpec request, TypeReference<T> type) {
    return parse(request.operation, send(prepare(request)), mapper.getTypeFactory().constructType(type));
  }

  /**
   * An answer whose shape depends on its HTTP status.
   *
   * @param <T> the union of the shapes
   * @param request the call
   * @param union the union
   * @param types the shape for each status
   * @return the answer
   */
  public <T> T byStatus(RequestSpec request, Class<T> union, Map<Integer, Class<? extends T>> types) {
    HttpResponse<byte[]> response = send(prepare(request));
    return union.cast(parse(request.operation, response, mapper.constructType(shape(request, response, types))));
  }

  /** @param request the call */
  public void empty(RequestSpec request) {
    send(prepare(request));
  }

  /**
   * @param request the call
   * @return the answer's bytes
   */
  public byte[] binary(RequestSpec request) {
    return send(prepare(request)).body();
  }

  /**
   * Opens a stream of events (it connects now, so a refused call throws here).
   *
   * @param <T> the event type
   * @param request the call
   * @param type the event type
   * @return the events
   */
  public <T> EventStream<T> stream(RequestSpec request, Class<T> type) {
    return new SseStream<>(prepare(request), mapper.constructType(type), false);
  }

  /**
   * Follows a run's stream of events through to its terminal one ({@code run.completed}, {@code
   * run.failed}, {@code run.cancelled}). The server ends a stream after a time limit while the run
   * is still going; this reconnects with {@code Last-Event-Id}, so each event comes once.
   *
   * @param <T> the event type (one with a {@code kind})
   * @param request the call
   * @param type the event type
   * @return the events, through to the run's terminal one
   */
  public <T> EventStream<T> follow(RequestSpec request, Class<T> type) {
    return new SseStream<>(prepare(request), mapper.constructType(type), true);
  }

  private Class<?> shape(RequestSpec request, HttpResponse<byte[]> response, Map<Integer, ? extends Class<?>> types) {
    Class<?> t = types.get(response.statusCode());
    if (t == null) {
      throw new KindgiApiException(
          request.operation.id() + ": unexpected status " + response.statusCode(), response.statusCode(), "invalid-response", null, null, null);
    }
    return t;
  }

  private HttpResponse<byte[]> send(Prepared p) {
    int attempt = 0;
    while (true) {
      attempt++;
      HttpResponse<byte[]> response;
      try {
        response = http.send(p.request(timeout, "application/json"), HttpResponse.BodyHandlers.ofByteArray());
      } catch (IOException e) {
        if (p.safe && attempt <= maxRetries) {
          sleep(backoff(attempt, null));
          continue;
        }
        throw new NetworkException(p.operation.id() + ": " + e.getClass().getSimpleName() + ": " + e.getMessage(), null, e);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new NetworkException(p.operation.id() + ": interrupted", null, e);
      }
      if (RETRY_STATUSES.contains(response.statusCode()) && p.safe && attempt <= maxRetries) {
        sleep(backoff(attempt, response.headers().firstValue("retry-after").orElse(null)));
        continue;
      }
      return check(p.operation, response);
    }
  }

  private <B> HttpResponse<B> check(Operation op, HttpResponse<B> response) {
    int status = response.statusCode();
    if (status >= 200 && status < 300) {
      return response;
    }
    throw error(op, status, response.headers().firstValue("retry-after").orElse(null), bodyBytes(response));
  }

  private static byte[] bodyBytes(HttpResponse<?> response) {
    Object body = response.body();
    if (body instanceof byte[]) {
      return (byte[]) body;
    }
    if (body instanceof InputStream) {
      try (InputStream in = (InputStream) body) {
        return in.readAllBytes();
      } catch (IOException e) {
        return new byte[0];
      }
    }
    return new byte[0];
  }

  private KindgiApiException error(Operation op, int status, @Nullable String retryAfter, byte[] body) {
    Object parsed;
    try {
      parsed = body.length == 0 ? null : mapper.readValue(body, Object.class);
    } catch (RuntimeException e) {
      parsed = null;
    }
    return WireErrors.fromWire(parsed, status, retryAfter);
  }

  @SuppressWarnings("unchecked")
  private <T> T parse(Operation op, HttpResponse<byte[]> response, JavaType type) {
    byte[] body = response.body();
    if (response.statusCode() == 204 || body.length == 0) {
      return null;
    }
    try {
      return (T) mapper.readValue(body, type);
    } catch (StreamReadException e) {
      throw new NetworkException(op.id() + ": the response body is not JSON", response.statusCode(), e);
    } catch (DatabindException e) {
      throw new KindgiApiException(
          op.id() + ": the response doesn't match the API's schema: " + e.getOriginalMessage(),
          response.statusCode(),
          "invalid-response",
          null,
          null,
          e);
    }
  }

  static Duration backoff(int attempt, @Nullable String retryAfter) {
    if (retryAfter != null) {
      try {
        return Duration.ofMillis((long) (Math.min(Double.parseDouble(retryAfter), 60.0) * 1000));
      } catch (NumberFormatException e) {
        // An HTTP date: use the exponential backoff.
      }
    }
    double seconds = Math.min(0.5 * Math.pow(2, attempt - 1), 8.0) * (0.75 + ThreadLocalRandom.current().nextDouble() / 2);
    return Duration.ofMillis((long) (seconds * 1000));
  }

  static Duration streamBackoff(int attempt) {
    return Duration.ofMillis((long) (Math.min(0.5 * Math.pow(2, attempt - 1), 30.0) * 1000));
  }

  private static void sleep(Duration d) {
    try {
      Thread.sleep(d.toMillis());
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new NetworkException("interrupted while waiting to retry", null, e);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Asynchronous
  // ---------------------------------------------------------------------------------------------

  /**
   * @param <T> the answer's type
   * @param request the call
   * @param type the answer's type
   * @return the answer, when it comes
   */
  public <T> CompletableFuture<T> jsonAsync(RequestSpec request, Class<T> type) {
    return sendAsync(request).thenApply(r -> parse(request.operation, r, mapper.constructType(type)));
  }

  /**
   * @param <T> the answer's type
   * @param request the call
   * @param type the answer's (generic) type
   * @return the answer, when it comes
   */
  public <T> CompletableFuture<T> jsonAsync(RequestSpec request, TypeReference<T> type) {
    return sendAsync(request).thenApply(r -> parse(request.operation, r, mapper.getTypeFactory().constructType(type)));
  }

  /**
   * @param <T> the union of the shapes
   * @param request the call
   * @param union the union
   * @param types the shape for each status
   * @return the answer, when it comes
   */
  public <T> CompletableFuture<T> byStatusAsync(RequestSpec request, Class<T> union, Map<Integer, Class<? extends T>> types) {
    return sendAsync(request)
        .thenApply(r -> union.cast(parse(request.operation, r, mapper.constructType(shape(request, r, types)))));
  }

  /**
   * @param request the call
   * @return done when the call is
   */
  public CompletableFuture<Void> emptyAsync(RequestSpec request) {
    return sendAsync(request).thenApply(r -> null);
  }

  /**
   * @param request the call
   * @return the answer's bytes, when they come
   */
  public CompletableFuture<byte[]> binaryAsync(RequestSpec request) {
    return sendAsync(request).thenApply(HttpResponse::body);
  }

  /**
   * The events as a {@link Flow.Publisher}: each subscriber gets its own stream, read on its own
   * thread; cancelling the subscription closes it.
   *
   * @param <T> the event type
   * @param request the call
   * @param type the event type
   * @return the publisher
   */
  public <T> Flow.Publisher<T> streamAsync(RequestSpec request, Class<T> type) {
    return publisher(request, () -> stream(request, type));
  }

  /**
   * {@link #follow}, as a publisher.
   *
   * @param <T> the event type
   * @param request the call
   * @param type the event type
   * @return the publisher
   */
  public <T> Flow.Publisher<T> followAsync(RequestSpec request, Class<T> type) {
    return publisher(request, () -> follow(request, type));
  }

  private <T> Flow.Publisher<T> publisher(RequestSpec request, java.util.function.Supplier<EventStream<T>> open) {
    return subscriber -> {
      SubmissionPublisher<T> publisher = new SubmissionPublisher<>();
      AtomicReference<EventStream<T>> opened = new AtomicReference<>();
      publisher.subscribe(
          new Flow.Subscriber<T>() {
            @Override
            public void onSubscribe(Flow.Subscription subscription) {
              subscriber.onSubscribe(
                  new Flow.Subscription() {
                    @Override
                    public void request(long n) {
                      subscription.request(n);
                    }

                    @Override
                    public void cancel() {
                      subscription.cancel();
                      EventStream<T> s = opened.get();
                      if (s != null) {
                        s.close();
                      }
                    }
                  });
            }

            @Override
            public void onNext(T item) {
              subscriber.onNext(item);
            }

            @Override
            public void onError(Throwable error) {
              subscriber.onError(error);
            }

            @Override
            public void onComplete() {
              subscriber.onComplete();
            }
          });
      Thread reader =
          new Thread(
              () -> {
                try (EventStream<T> events = open.get()) {
                  opened.set(events);
                  while (events.hasNext()) {
                    T next = events.next();
                    if (publisher.getNumberOfSubscribers() == 0) {
                      break;
                    }
                    publisher.submit(next);
                  }
                  publisher.close();
                } catch (RuntimeException e) {
                  publisher.closeExceptionally(e);
                }
              },
              "kindgi-stream-" + request.operation.id());
      reader.setDaemon(true);
      reader.start();
    };
  }

  private CompletableFuture<HttpResponse<byte[]>> sendAsync(RequestSpec request) {
    Prepared p;
    try {
      p = prepare(request);
    } catch (RuntimeException e) {
      return CompletableFuture.failedFuture(e);
    }
    return attemptAsync(p, 1);
  }

  private CompletableFuture<HttpResponse<byte[]>> attemptAsync(Prepared p, int attempt) {
    return http.sendAsync(p.request(timeout, "application/json"), HttpResponse.BodyHandlers.ofByteArray())
        .handle(
            (response, failure) -> {
              if (failure != null) {
                Throwable cause = failure instanceof CompletionException && failure.getCause() != null ? failure.getCause() : failure;
                if (cause instanceof IOException && p.safe && attempt <= maxRetries) {
                  return later(backoff(attempt, null)).thenCompose(x -> attemptAsync(p, attempt + 1));
                }
                return CompletableFuture.<HttpResponse<byte[]>>failedFuture(
                    new NetworkException(p.operation.id() + ": " + cause.getClass().getSimpleName() + ": " + cause.getMessage(), null, cause));
              }
              if (RETRY_STATUSES.contains(response.statusCode()) && p.safe && attempt <= maxRetries) {
                return later(backoff(attempt, response.headers().firstValue("retry-after").orElse(null)))
                    .thenCompose(x -> attemptAsync(p, attempt + 1));
              }
              try {
                return CompletableFuture.completedFuture(check(p.operation, response));
              } catch (KindgiApiException e) {
                return CompletableFuture.<HttpResponse<byte[]>>failedFuture(e);
              }
            })
        .thenCompose(f -> f);
  }

  private static CompletableFuture<Void> later(Duration d) {
    return CompletableFuture.runAsync(() -> {}, CompletableFuture.delayedExecutor(d.toMillis(), TimeUnit.MILLISECONDS));
  }

  // ---------------------------------------------------------------------------------------------
  // Requests
  // ---------------------------------------------------------------------------------------------

  /** A call ready to send (and to send again: the idempotency key stays the same). */
  private static final class Prepared {
    final Operation operation;
    final URI uri;
    final Map<String, String> headers;
    final byte @Nullable [] body;
    final boolean safe;

    Prepared(Operation operation, URI uri, Map<String, String> headers, byte @Nullable [] body) {
      this.operation = operation;
      this.uri = uri;
      this.headers = headers;
      this.body = body;
      this.safe = operation.method().equals("GET") || hasHeader(headers, "Idempotency-Key");
    }

    HttpRequest request(Duration timeout, String accept) {
      HttpRequest.Builder b = HttpRequest.newBuilder(uri).timeout(timeout);
      b.method(operation.method(), body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(body));
      b.header("Accept", accept);
      headers.forEach(b::header);
      return b.build();
    }
  }

  private static boolean hasHeader(Map<String, String> headers, String name) {
    for (String k : headers.keySet()) {
      if (k.equalsIgnoreCase(name)) {
        return true;
      }
    }
    return false;
  }

  private Prepared prepare(RequestSpec r) {
    Operation op = r.operation;
    String path = op.path();
    for (Map.Entry<String, String> e : r.path.entrySet()) {
      path = path.replace("{" + e.getKey() + "}", Wire.pathSegment(e.getValue()));
    }
    if (path.contains("{")) {
      throw new IllegalArgumentException(op.id() + ": a path parameter is missing: " + path);
    }
    StringBuilder url = new StringBuilder(baseUrl).append(path);
    char sep = '?';
    for (Map.Entry<String, String> q : r.query) {
      url.append(sep).append(Wire.query(q.getKey())).append('=').append(Wire.query(q.getValue()));
      sep = '&';
    }
    Map<String, String> headers = new LinkedHashMap<>();
    headers.put("Authorization", "Bearer " + token);
    headers.put("User-Agent", "kindgi-java/" + Version.VERSION);
    headers.putAll(defaultHeaders);
    headers.putAll(r.headers);
    if (op.idempotencyKey() && !hasHeader(headers, "Idempotency-Key")) {
      headers.put("Idempotency-Key", UUID.randomUUID().toString());
    }
    byte[] body = null;
    if (r.json != null) {
      if (r.json instanceof Model) {
        ((Model) r.json).validate();
      }
      body = mapper.writeValueAsBytes(r.json);
      headers.put("Content-Type", "application/json");
    } else if (r.multipart != null) {
      String boundary = "kindgi-" + UUID.randomUUID();
      body = r.multipart.encode(boundary);
      headers.put("Content-Type", "multipart/form-data; boundary=" + boundary);
    }
    return new Prepared(op, URI.create(url.toString()), headers, body);
  }

  // ---------------------------------------------------------------------------------------------
  // Streams
  // ---------------------------------------------------------------------------------------------

  /** What ends a run: a followed stream stops after one of these. */
  static final Set<String> TERMINAL_KINDS = Set.of("run.completed", "run.failed", "run.cancelled");

  /** How long a followed stream waits before reconnecting after a connection that brought nothing. */
  static final Duration EMPTY_CONNECTION_PAUSE = Duration.ofMillis(500);

  private final class SseStream<T> implements EventStream<T> {
    private final Prepared prepared;
    private final JavaType type;
    private final boolean follow;
    private int receivedSinceConnect;
    private @Nullable BufferedReader reader;
    private @Nullable InputStream body;
    private @Nullable SseParser parser;
    private @Nullable T next;
    private @Nullable String lastEventId;
    private volatile boolean closed;
    private boolean ended;

    SseStream(Prepared prepared, JavaType type, boolean follow) {
      this.prepared = prepared;
      this.type = type;
      this.follow = follow;
      connect(0);
    }

    /** Connects, retrying a connection error; a refused call throws. */
    private void connect(int priorAttempts) {
      int attempt = priorAttempts;
      while (true) {
        Map<String, String> headers = new LinkedHashMap<>(prepared.headers);
        if (lastEventId != null) {
          headers.put("Last-Event-Id", lastEventId);
        }
        Prepared p = new Prepared(prepared.operation, prepared.uri, headers, prepared.body);
        try {
          HttpResponse<InputStream> response =
              http.send(p.request(timeout, "text/event-stream"), HttpResponse.BodyHandlers.ofInputStream());
          check(prepared.operation, response);
          body = response.body();
          reader = new BufferedReader(new InputStreamReader(body, StandardCharsets.UTF_8));
          parser = new SseParser();
          return;
        } catch (IOException e) {
          attempt++;
          if (attempt > STREAM_ATTEMPTS) {
            throw new NetworkException(
                prepared.operation.id() + ": the stream couldn't connect after " + (attempt - 1) + " attempts: " + e.getMessage(), null, e);
          }
          sleep(streamBackoff(attempt));
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
          throw new NetworkException(prepared.operation.id() + ": interrupted", null, e);
        }
      }
    }

    @Override
    public @Nullable String lastEventId() {
      return lastEventId;
    }

    @Override
    public boolean hasNext() {
      if (next != null) {
        return true;
      }
      int drops = 0;
      while (!closed && !ended) {
        String line;
        try {
          line = Objects.requireNonNull(reader).readLine();
        } catch (IOException e) {
          if (closed) {
            return false;
          }
          drops++;
          if (drops > STREAM_ATTEMPTS) {
            throw new NetworkException(prepared.operation.id() + ": the stream dropped " + (drops - 1) + " times: " + e.getMessage(), null, e);
          }
          closeBody();
          sleep(streamBackoff(drops));
          connect(drops);
          continue;
        }
        if (line == null) {
          closeBody();
          if (follow && !closed) {
            // The server closed the stream before the run ended (its time limit): reconnect after
            // the last event. Pause first when the connection brought nothing, so a server that
            // keeps closing doesn't spin us.
            if (receivedSinceConnect == 0) {
              sleep(EMPTY_CONNECTION_PAUSE);
            }
            receivedSinceConnect = 0;
            connect(0);
            continue;
          }
          ended = true;
          return false;
        }
        SseParser.Event event = Objects.requireNonNull(parser).feed(line);
        if (event == null) {
          continue;
        }
        if (event.id() != null) {
          lastEventId = event.id();
        }
        T value;
        boolean terminal = false;
        try {
          if (follow) {
            JsonNode node = mapper.readTree(event.data());
            terminal = TERMINAL_KINDS.contains(node.path("kind").asString(""));
            value = mapper.readerFor(type).readValue(node);
          } else {
            value = mapper.readValue(event.data(), type);
          }
        } catch (StreamReadException e) {
          continue; // Not JSON: dropped, as the other clients do; one bad event doesn't end the stream.
        } catch (DatabindException e) {
          throw new KindgiApiException(
              prepared.operation.id() + ": an event doesn't match the API's schema: " + e.getOriginalMessage(), null, "invalid-response", null, null, e);
        }
        receivedSinceConnect++;
        if (terminal) {
          // The run ended: so does the stream, whatever the server does next.
          ended = true;
          closeBody();
        }
        if (value != null) {
          next = value;
          return true;
        }
      }
      return false;
    }

    @Override
    public T next() {
      if (!hasNext()) {
        throw new NoSuchElementException();
      }
      T value = next;
      next = null;
      return value;
    }

    @Override
    public void close() {
      closed = true;
      closeBody();
    }

    private void closeBody() {
      InputStream b = body;
      body = null;
      if (b != null) {
        try {
          b.close();
        } catch (IOException e) {
          // Closing a dropped connection: nothing to do.
        }
      }
    }
  }
}
