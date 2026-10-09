// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import java.io.BufferedInputStream;
import java.io.Closeable;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import org.jspecify.annotations.Nullable;

/**
 * The pack service's HTTP/1.1 server: small and strict, because it only ever talks to the Kindgi
 * runtime (through Cloud Run's front end, or {@code kindgi dev}), never to the public.
 *
 * <ul>
 *   <li>One request per connection: every response says {@code connection: close}.
 *   <li>A body has a {@code Content-Length}; {@code Transfer-Encoding} (chunked) is refused.
 *   <li>The request line, the headers and their count are capped, and so is the time to send
 *       them; a body read stalls out too.
 *   <li>Anything unexpected (bare LF, folded headers, whitespace before a colon, conflicting
 *       lengths, a target that isn't a path) is a 400.
 *   <li>The handler sees the request line and headers before the body, so it answers 401, 413 and
 *       the like without reading one.
 * </ul>
 */
public final class HttpServer implements Closeable {
  static final int MAX_REQUEST_LINE = 8 * 1024;
  static final int MAX_HEADER_BYTES = 32 * 1024;
  static final int MAX_HEADERS = 100;
  static final int HEADER_TIMEOUT_MS = 10_000;
  static final int BODY_IDLE_TIMEOUT_MS = 30_000;
  static final long BODY_TIMEOUT_MS = 120_000;
  /** What a response may leave unread (a refused body) and still drain, so the client reads the answer. */
  static final long MAX_DRAIN_BYTES = 64L * 1024 * 1024;
  static final int DRAIN_TIMEOUT_MS = 5_000;

  /** Answers one request. */
  public interface Handler {
    /**
     * @param exchange the request so far (line and headers), and the way to answer it
     * @throws IOException when the connection fails
     */
    void handle(Exchange exchange) throws IOException;
  }

  private final ServerSocket socket;
  private final Handler handler;
  private final int maxConnections;
  private final AtomicInteger connections = new AtomicInteger();
  private final ExecutorService workers;
  private final int headerTimeoutMs;
  private volatile boolean closed;

  /**
   * @param socket a bound server socket
   * @param handler answers each request
   * @param maxConnections connections served at once; one more is answered 503 and closed
   */
  public HttpServer(ServerSocket socket, Handler handler, int maxConnections) {
    this(socket, handler, maxConnections, HEADER_TIMEOUT_MS);
  }

  HttpServer(ServerSocket socket, Handler handler, int maxConnections, int headerTimeoutMs) {
    this.headerTimeoutMs = headerTimeoutMs;
    this.socket = socket;
    this.handler = handler;
    this.maxConnections = maxConnections;
    AtomicInteger n = new AtomicInteger();
    this.workers = Executors.newCachedThreadPool(r -> {
      Thread t = new Thread(r, "kindgi-pack-http-" + n.incrementAndGet());
      t.setDaemon(true);
      return t;
    });
  }

  /** @return the port it listens on */
  public int port() {
    return socket.getLocalPort();
  }

  /** Accepts connections until {@link #close()}. */
  public void serve() {
    while (!closed) {
      Socket client;
      try {
        client = socket.accept();
      } catch (IOException e) {
        if (closed) {
          return;
        }
        continue;
      }
      if (connections.incrementAndGet() > maxConnections) {
        connections.decrementAndGet();
        refuse(client);
        continue;
      }
      workers.execute(() -> {
        try {
          serveOne(client);
        } finally {
          connections.decrementAndGet();
        }
      });
    }
  }

  @Override
  public void close() throws IOException {
    closed = true;
    socket.close();
    workers.shutdownNow();
  }

  private static void refuse(Socket client) {
    try (client) {
      client.setSoTimeout(100);
      byte[] body = "{\"error\":\"overloaded\"}".getBytes(StandardCharsets.UTF_8);
      Map<String, String> headers = new LinkedHashMap<>();
      headers.put("retry-after", "1");
      write(client.getOutputStream(), 503, headers, body);
      client.shutdownOutput();
      drain(client.getInputStream(), 64 * 1024, 100);
    } catch (IOException e) {
      // The client went away first.
    }
  }

  private void serveOne(Socket client) {
    try (client) {
      client.setTcpNoDelay(true);
      Exchange exchange;
      InputStream in = new BufferedInputStream(client.getInputStream(), 8192);
      try {
        exchange = parse(client, in, headerTimeoutMs);
      } catch (BadRequest e) {
        Exchange.reply(client, 400, Map.of(), errorBody("Bad request: " + e.getMessage()));
        return;
      } catch (SocketTimeoutException e) {
        Exchange.reply(client, 408, Map.of(), errorBody("Request timeout"));
        return;
      } catch (EOFException e) {
        return;
      }
      try {
        handler.handle(exchange);
      } catch (BadRequest e) {
        if (!exchange.answered) {
          exchange.error(400, "Bad request: " + e.getMessage());
        }
      } catch (SocketTimeoutException e) {
        if (!exchange.answered) {
          exchange.error(408, "Request timeout");
        }
      }
      exchange.finish();
    } catch (IOException e) {
      // The client went away; nothing to answer.
    }
  }

  static byte[] errorBody(String message) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("error", message);
    return Json.compact(body);
  }

  // ---------------------------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------------------------

  /** The request isn't one this server takes; a 400. */
  static final class BadRequest extends IOException {
    private static final long serialVersionUID = 1L;

    BadRequest(String message) {
      super(message);
    }
  }

  static Exchange parse(Socket client, InputStream in, int headerTimeoutMs) throws IOException {
    long deadline = System.nanoTime() + headerTimeoutMs * 1_000_000L;
    Reader reader = new Reader(client, in, deadline);
    String requestLine = reader.line(MAX_REQUEST_LINE, true);
    if (requestLine == null) {
      throw new EOFException();
    }
    String[] parts = requestLine.split(" ", -1);
    if (parts.length != 3) {
      throw new BadRequest("the request line isn't METHOD SP TARGET SP VERSION");
    }
    String method = parts[0];
    String target = parts[1];
    String version = parts[2];
    if (method.isEmpty() || !isToken(method)) {
      throw new BadRequest("not a method: " + printable(method));
    }
    if (!version.equals("HTTP/1.1") && !version.equals("HTTP/1.0")) {
      throw new BadRequest("not HTTP/1.1: " + printable(version));
    }
    if (!target.startsWith("/") || !isTarget(target)) {
      throw new BadRequest("the target isn't a path");
    }
    int query = target.indexOf('?');
    String path = query == -1 ? target : target.substring(0, query);

    Map<String, List<String>> headers = new LinkedHashMap<>();
    int count = 0;
    int bytes = 0;
    while (true) {
      String line = reader.line(MAX_HEADER_BYTES - bytes, false);
      if (line == null) {
        throw new EOFException();
      }
      if (line.isEmpty()) {
        break;
      }
      bytes += line.length() + 2;
      if (++count > MAX_HEADERS) {
        throw new BadRequest("more than " + MAX_HEADERS + " headers");
      }
      char first = line.charAt(0);
      if (first == ' ' || first == '\t') {
        throw new BadRequest("a folded header line");
      }
      int colon = line.indexOf(':');
      if (colon <= 0) {
        throw new BadRequest("a header line without a name");
      }
      String name = line.substring(0, colon);
      if (!isToken(name)) {
        throw new BadRequest("not a header name: " + printable(name));
      }
      String value = line.substring(colon + 1).strip();
      for (int i = 0; i < value.length(); i++) {
        char c = value.charAt(i);
        if ((c < 0x20 && c != '\t') || c == 0x7f) {
          throw new BadRequest("a control character in header " + name);
        }
      }
      headers.computeIfAbsent(name.toLowerCase(Locale.ROOT), k -> new ArrayList<>()).add(value);
    }
    if (headers.containsKey("transfer-encoding")) {
      throw new BadRequest("Transfer-Encoding isn't supported; send the body with a Content-Length");
    }
    long contentLength = 0;
    List<String> lengths = headers.get("content-length");
    if (lengths != null) {
      String agreed = null;
      for (String header : lengths) {
        for (String value : header.split(",", -1)) {
          String v = value.strip();
          if (v.isEmpty() || v.length() > 18 || !v.chars().allMatch(c -> c >= '0' && c <= '9')) {
            throw new BadRequest("not a Content-Length: " + printable(header));
          }
          if (agreed != null && !agreed.equals(v)) {
            throw new BadRequest("conflicting Content-Length values");
          }
          agreed = v;
        }
      }
      contentLength = Long.parseLong(agreed);
    }
    return new Exchange(client, in, method, path, headers, contentLength);
  }

  /** Reads CRLF-terminated lines, strictly, within a deadline. */
  private static final class Reader {
    private final Socket client;
    private final InputStream in;
    private final long deadline;

    Reader(Socket client, InputStream in, long deadline) {
      this.client = client;
      this.in = in;
      this.deadline = deadline;
    }

    /** @return the line without its CRLF; {@code null} at a clean EOF before the first byte of a request */
    @Nullable String line(int max, boolean first) throws IOException {
      StringBuilder out = new StringBuilder();
      while (true) {
        int c = read();
        if (c == -1) {
          if (first && out.length() == 0) {
            return null;
          }
          throw new EOFException();
        }
        if (c == '\r') {
          if (read() != '\n') {
            throw new BadRequest("a CR without LF");
          }
          return out.toString();
        }
        if (c == '\n') {
          throw new BadRequest("a line ends with a bare LF");
        }
        if (c == 0) {
          throw new BadRequest("a NUL byte");
        }
        if (out.length() >= max) {
          throw new BadRequest(first ? "the request line is too long" : "the headers are too long");
        }
        out.append((char) c);
      }
    }

    private int read() throws IOException {
      long left = (deadline - System.nanoTime()) / 1_000_000L;
      if (left <= 0) {
        throw new SocketTimeoutException("headers");
      }
      client.setSoTimeout((int) Math.min(left, Integer.MAX_VALUE));
      return in.read();
    }
  }

  private static boolean isToken(String s) {
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
          || "!#$%&'*+-.^_`|~".indexOf(c) >= 0;
      if (!ok) {
        return false;
      }
    }
    return true;
  }

  private static boolean isTarget(String s) {
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c <= 0x20 || c >= 0x7f || c == '#') {
        return false;
      }
    }
    return true;
  }

  private static String printable(String s) {
    String cut = s.length() > 64 ? s.substring(0, 64) + "…" : s;
    StringBuilder out = new StringBuilder();
    for (char c : cut.toCharArray()) {
      out.append(c >= 0x20 && c < 0x7f ? String.valueOf(c) : String.format("\\x%02x", (int) c));
    }
    return out.toString();
  }

  // ---------------------------------------------------------------------------------------------
  // Answering
  // ---------------------------------------------------------------------------------------------

  private static final Map<Integer, String> REASONS = Map.ofEntries(
      Map.entry(100, "Continue"),
      Map.entry(200, "OK"),
      Map.entry(400, "Bad Request"),
      Map.entry(401, "Unauthorized"),
      Map.entry(404, "Not Found"),
      Map.entry(405, "Method Not Allowed"),
      Map.entry(408, "Request Timeout"),
      Map.entry(413, "Content Too Large"),
      Map.entry(415, "Unsupported Media Type"),
      Map.entry(417, "Expectation Failed"),
      Map.entry(500, "Internal Server Error"),
      Map.entry(503, "Service Unavailable"));

  static void write(OutputStream out, int status, Map<String, String> headers, byte[] body) throws IOException {
    StringBuilder head = new StringBuilder();
    head.append("HTTP/1.1 ").append(status).append(' ').append(REASONS.getOrDefault(status, "Status")).append("\r\n");
    head.append("content-type: application/json; charset=utf-8\r\n");
    head.append("content-length: ").append(body.length).append("\r\n");
    head.append("connection: close\r\n");
    headers.forEach((k, v) -> head.append(k).append(": ").append(v).append("\r\n"));
    head.append("\r\n");
    out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
    out.write(body);
    out.flush();
  }

  /** Reads and drops up to {@code max} bytes, until EOF or {@code timeoutMs} of quiet. */
  static void drain(InputStream in, long max, int timeoutMs) {
    byte[] scratch = new byte[8192];
    long read = 0;
    try {
      while (read < max) {
        int n = in.read(scratch, 0, (int) Math.min(scratch.length, max - read));
        if (n == -1) {
          return;
        }
        read += n;
      }
    } catch (IOException e) {
      // Timed out or reset: done either way.
    }
  }

  /** How a wait for a call ended. */
  public enum Wait {
    /** The call finished. */
    DONE,
    /** The client closed the connection. */
    DISCONNECTED,
    /** The deadline passed. */
    DEADLINE
  }

  /** One request: its line and headers, its body on demand, and its answer. */
  public static final class Exchange {
    private final Socket client;
    private final InputStream in;
    private final String method;
    private final String path;
    private final Map<String, List<String>> headers;
    private final long contentLength;
    private long bodyRead;
    private boolean answered;
    private volatile boolean inputShut;

    Exchange(Socket client, InputStream in, String method, String path, Map<String, List<String>> headers, long contentLength) {
      this.client = client;
      this.in = in;
      this.method = method;
      this.path = path;
      this.headers = headers;
      this.contentLength = contentLength;
    }

    /** @return the method ({@code GET}, {@code POST}) */
    public String method() {
      return method;
    }

    /** @return the path, without the query */
    public String path() {
      return path;
    }

    /**
     * @param name a header name, any case
     * @return its first value; {@code null} when absent
     */
    public @Nullable String header(String name) {
      List<String> values = headers.get(name.toLowerCase(Locale.ROOT));
      return values == null || values.isEmpty() ? null : values.get(0);
    }

    /** @return the body's declared length (0 without one) */
    public long contentLength() {
      return contentLength;
    }

    /**
     * Reads the whole body. Answers {@code Expect: 100-continue} first.
     *
     * @return the body
     * @throws IOException when the client goes away or stalls
     */
    public byte[] body() throws IOException {
      String expect = header("expect");
      if (expect != null) {
        if (!expect.equalsIgnoreCase("100-continue")) {
          throw new BadRequest("unsupported Expect: " + printable(expect));
        }
        OutputStream out = client.getOutputStream();
        out.write("HTTP/1.1 100 Continue\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
      }
      if (contentLength > Integer.MAX_VALUE - 16) {
        throw new BadRequest("the body is too large");
      }
      byte[] body = new byte[(int) contentLength];
      long deadline = System.nanoTime() + BODY_TIMEOUT_MS * 1_000_000L;
      int off = 0;
      while (off < body.length) {
        long left = (deadline - System.nanoTime()) / 1_000_000L;
        if (left <= 0) {
          throw new SocketTimeoutException("body");
        }
        client.setSoTimeout((int) Math.min(left, BODY_IDLE_TIMEOUT_MS));
        int n = in.read(body, off, body.length - off);
        if (n == -1) {
          throw new EOFException("the client closed the connection mid-body");
        }
        off += n;
        bodyRead += n;
      }
      return body;
    }

    /**
     * Waits for a call to finish, for the client to go away, or for the deadline, whichever comes
     * first. The client sends nothing more on this connection, so a read that returns is the
     * client going away; the call wakes the wait by {@link #wake()}.
     *
     * @param done whether the call finished
     * @param deadlineNanos the deadline ({@link System#nanoTime()})
     * @return why the wait ended
     */
    public Wait await(BooleanSupplier done, long deadlineNanos) {
      byte[] scratch = new byte[1024];
      long ignored = 0;
      while (true) {
        if (done.getAsBoolean()) {
          return Wait.DONE;
        }
        long left = (deadlineNanos - System.nanoTime()) / 1_000_000L;
        if (left <= 0) {
          return Wait.DEADLINE;
        }
        int n;
        try {
          client.setSoTimeout((int) Math.min(left, Integer.MAX_VALUE));
          n = in.read(scratch);
        } catch (SocketTimeoutException e) {
          continue;
        } catch (IOException e) {
          return done.getAsBoolean() ? Wait.DONE : Wait.DISCONNECTED;
        }
        if (n == -1) {
          if (done.getAsBoolean() || inputShut) {
            // Woken by the call (or it finished just now).
            return done.getAsBoolean() ? Wait.DONE : Wait.DISCONNECTED;
          }
          return Wait.DISCONNECTED;
        }
        // Bytes after the request: one request per connection, so they're dropped.
        ignored += n;
        if (ignored > 64 * 1024) {
          return Wait.DISCONNECTED;
        }
      }
    }

    /** Ends an {@link #await} in progress (or the next one): call it when the call finishes. */
    public void wake() {
      inputShut = true;
      try {
        client.shutdownInput();
      } catch (IOException e) {
        // Already closed.
      }
    }

    /**
     * Answers the request.
     *
     * @param status the status
     * @param extra headers besides content-type, content-length and connection
     * @param body the JSON body
     * @throws IOException when the client went away
     */
    public void respond(int status, Map<String, String> extra, byte[] body) throws IOException {
      if (answered) {
        throw new IllegalStateException("answered twice");
      }
      answered = true;
      write(client.getOutputStream(), status, extra, body);
    }

    /**
     * Answers with {@code {"error": message}}.
     *
     * @param status the status
     * @param message the error
     * @throws IOException when the client went away
     */
    public void error(int status, String message) throws IOException {
      respond(status, Map.of(), errorBody(message));
    }

    static void reply(Socket client, int status, Map<String, String> extra, byte[] body) {
      try {
        write(client.getOutputStream(), status, extra, body);
        client.shutdownOutput();
        client.setSoTimeout(DRAIN_TIMEOUT_MS);
        drain(client.getInputStream(), MAX_DRAIN_BYTES, DRAIN_TIMEOUT_MS);
      } catch (IOException e) {
        // The client went away first.
      }
    }

    /** After the answer: closes our side, first draining a body left unread so the client reads the answer. */
    void finish() throws IOException {
      if (!answered) {
        respond(500, Map.of(), errorBody("No answer"));
      }
      try {
        client.shutdownOutput();
      } catch (SocketException e) {
        return;
      }
      long unread = contentLength - bodyRead;
      if (unread > 0 && !inputShut) {
        client.setSoTimeout(DRAIN_TIMEOUT_MS);
        drain(in, Math.min(unread, MAX_DRAIN_BYTES), DRAIN_TIMEOUT_MS);
      }
    }
  }
}
