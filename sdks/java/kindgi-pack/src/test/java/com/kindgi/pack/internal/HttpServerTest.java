// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * The HTTP server against malformed, oversized, slow and random requests: each is a 400 (or a
 * 408, or a closed connection), never a crash, and the server goes on serving.
 */
class HttpServerTest {
  private static final int HEADER_TIMEOUT_MS = 500;

  private HttpServer server;
  private Thread acceptor;
  private final List<String> handled = new CopyOnWriteArrayList<>();
  private volatile HttpServer.Handler handler;

  @BeforeEach
  void start() throws IOException {
    ServerSocket socket = new ServerSocket();
    socket.bind(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0));
    handler = ex -> {
      handled.add(ex.method() + " " + ex.path());
      byte[] body = ex.body();
      ex.respond(200, Map.of(), Json.compact(Map.of("got", body.length)));
    };
    server = new HttpServer(socket, ex -> handler.handle(ex), 4, HEADER_TIMEOUT_MS);
    acceptor = new Thread(server::serve, "test-acceptor");
    acceptor.start();
  }

  @AfterEach
  void stop() throws Exception {
    server.close();
    acceptor.join(2_000);
  }

  /** Sends raw bytes; returns everything the server answers before it closes. */
  private String exchange(byte[] request) throws IOException {
    try (Socket s = new Socket(InetAddress.getLoopbackAddress(), server.port())) {
      s.setSoTimeout(10_000);
      OutputStream out = s.getOutputStream();
      try {
        out.write(request);
        out.flush();
        s.shutdownOutput();
      } catch (IOException e) {
        // The server answered and closed first; read what it said.
      }
      return read(s.getInputStream());
    }
  }

  private String exchange(String request) throws IOException {
    return exchange(request.getBytes(StandardCharsets.ISO_8859_1));
  }

  private static String read(InputStream in) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buf = new byte[8192];
    try {
      int n;
      while ((n = in.read(buf)) != -1) {
        out.write(buf, 0, n);
      }
    } catch (IOException e) {
      // A reset after the answer.
    }
    return out.toString(StandardCharsets.ISO_8859_1);
  }

  private static String status(String response) {
    int end = response.indexOf("\r\n");
    return end == -1 ? response : response.substring(0, end);
  }

  @Test
  void aWellFormedRequestReachesTheHandler() throws IOException {
    String response = exchange("POST /v1/invoke?x=1 HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\n\r\nhello");
    assertThat(status(response)).isEqualTo("HTTP/1.1 200 OK");
    assertThat(response).contains("connection: close\r\n").contains("content-length: 9\r\n").endsWith("{\"got\":5}");
    assertThat(handled).containsExactly("POST /v1/invoke");
  }

  @Test
  void repeatedEqualContentLengthsAreOne() throws IOException {
    assertThat(status(exchange("POST / HTTP/1.1\r\nContent-Length: 2\r\nContent-Length: 2, 2\r\n\r\nhi")))
        .isEqualTo("HTTP/1.1 200 OK");
  }

  @ParameterizedTest
  @ValueSource(strings = {
    "GET / HTTP/1.1\nHost: a\n\n", // bare LF
    "GET / HTTP/1.1\r\nHost: a\n\r\n", // bare LF in a header
    "GET / HTTP/1.1\r\nHost: a\rb\r\n\r\n", // CR without LF
    "GET / HTTP/1.1\r\nX: a\r\n folded\r\n\r\n", // obs-fold
    "GET / HTTP/1.1\r\nHost : a\r\n\r\n", // whitespace before the colon
    "GET / HTTP/1.1\r\n: a\r\n\r\n", // no name
    "GET / HTTP/1.1\r\nno colon\r\n\r\n",
    "GET / HTTP/1.1\r\nX: a\u0001b\r\n\r\n", // a control character
    "GET / HTTP/1.1\r\nX: a\u0000b\r\n\r\n", // NUL
    "POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
    "POST / HTTP/1.1\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\nhello",
    "POST / HTTP/1.1\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello!",
    "POST / HTTP/1.1\r\nContent-Length: 5, 6\r\n\r\nhello!",
    "POST / HTTP/1.1\r\nContent-Length: +5\r\n\r\nhello",
    "POST / HTTP/1.1\r\nContent-Length: -1\r\n\r\n",
    "POST / HTTP/1.1\r\nContent-Length: 0x5\r\n\r\nhello",
    "POST / HTTP/1.1\r\nContent-Length: \r\n\r\n",
    "POST / HTTP/1.1\r\nContent-Length: 99999999999999999999\r\n\r\n",
    "GET / HTTP/2.0\r\n\r\n",
    "GET /\r\n\r\n",
    "GET  / HTTP/1.1\r\n\r\n", // two spaces
    "GET / HTTP/1.1 \r\n\r\n", // trailing space
    "GET http://acme.test/ HTTP/1.1\r\n\r\n", // absolute form
    "OPTIONS * HTTP/1.1\r\n\r\n",
    "GET /a#b HTTP/1.1\r\n\r\n",
    "GET /aÿ HTTP/1.1\r\n\r\n",
    "G(T / HTTP/1.1\r\n\r\n", // not a token
    "\r\nGET / HTTP/1.1\r\n\r\n", // a leading empty line
  })
  void malformedRequestsAre400(String request) throws IOException {
    String response = exchange(request);
    assertThat(status(response)).isEqualTo("HTTP/1.1 400 Bad Request");
    assertThat(response).contains("{\"error\":\"Bad request: ");
    assertThat(handled).isEmpty();
  }

  @Test
  void anOverlongRequestLineIs400() throws IOException {
    String response = exchange("GET /" + "a".repeat(HttpServer.MAX_REQUEST_LINE) + " HTTP/1.1\r\n\r\n");
    assertThat(status(response)).isEqualTo("HTTP/1.1 400 Bad Request");
    assertThat(response).contains("too long");
  }

  @Test
  void overlongHeadersAre400() throws IOException {
    String big = "X-Big: " + "a".repeat(HttpServer.MAX_HEADER_BYTES) + "\r\n";
    assertThat(status(exchange("GET / HTTP/1.1\r\n" + big + "\r\n"))).isEqualTo("HTTP/1.1 400 Bad Request");
    StringBuilder many = new StringBuilder("GET / HTTP/1.1\r\n");
    for (int i = 0; i <= HttpServer.MAX_HEADERS; i++) {
      many.append("X-").append(i).append(": a\r\n");
    }
    String response = exchange(many.append("\r\n").toString());
    assertThat(status(response)).isEqualTo("HTTP/1.1 400 Bad Request");
    assertThat(response).contains("more than 100 headers");
  }

  @Test
  void headersSentTooSlowlyAre408() throws Exception {
    try (Socket s = new Socket(InetAddress.getLoopbackAddress(), server.port())) {
      s.setSoTimeout(10_000);
      s.getOutputStream().write("GET / HTTP/1.1\r\nHost: a\r\n".getBytes(StandardCharsets.ISO_8859_1));
      long started = System.nanoTime();
      String response = read(s.getInputStream());
      assertThat(status(response)).isEqualTo("HTTP/1.1 408 Request Timeout");
      assertThat((System.nanoTime() - started) / 1_000_000L).isLessThan(5_000);
    }
  }

  @Test
  void aConnectionClosedBeforeARequestIsJustClosed() throws IOException {
    assertThat(exchange("")).isEmpty();
    assertThat(exchange("GET / HTTP/1.1\r\nHost:")).isEmpty();
    assertThat(handled).isEmpty();
  }

  @Test
  void expect100ContinueIsAnswered() throws IOException {
    try (Socket s = new Socket(InetAddress.getLoopbackAddress(), server.port())) {
      s.setSoTimeout(5_000);
      OutputStream out = s.getOutputStream();
      out.write("POST / HTTP/1.1\r\nContent-Length: 2\r\nExpect: 100-continue\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
      out.flush();
      byte[] interim = new byte["HTTP/1.1 100 Continue\r\n\r\n".length()];
      int off = 0;
      while (off < interim.length) {
        off += s.getInputStream().read(interim, off, interim.length - off);
      }
      assertThat(new String(interim, StandardCharsets.ISO_8859_1)).isEqualTo("HTTP/1.1 100 Continue\r\n\r\n");
      out.write("hi".getBytes(StandardCharsets.ISO_8859_1));
      out.flush();
      assertThat(read(s.getInputStream())).startsWith("HTTP/1.1 200 OK").endsWith("{\"got\":2}");
    }
    assertThat(status(exchange("POST / HTTP/1.1\r\nContent-Length: 1\r\nExpect: 200-ok\r\n\r\nx")))
        .isEqualTo("HTTP/1.1 400 Bad Request");
  }

  @Test
  void aBodyLeftUnreadIsDrainedSoTheClientReadsTheAnswer() throws IOException {
    handler = ex -> ex.error(401, "Bad pack token");
    byte[] head = "POST / HTTP/1.1\r\nContent-Length: 20971520\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1);
    byte[] request = new byte[head.length + 20 * 1024 * 1024];
    System.arraycopy(head, 0, request, 0, head.length);
    String response = exchange(request);
    assertThat(status(response)).isEqualTo("HTTP/1.1 401 Unauthorized");
  }

  @Test
  void aHandlerAnswersBeforeTheBodyArrives() throws IOException {
    handler = ex -> ex.error(401, "Bad pack token");
    try (Socket s = new Socket(InetAddress.getLoopbackAddress(), server.port())) {
      s.setSoTimeout(5_000);
      // Announces 50 MiB and sends none of it: the answer comes anyway.
      s.getOutputStream().write("POST / HTTP/1.1\r\nContent-Length: 52428800\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
      byte[] buf = new byte[64];
      int n = s.getInputStream().read(buf);
      assertThat(new String(buf, 0, n, StandardCharsets.ISO_8859_1)).startsWith("HTTP/1.1 401 Unauthorized");
    }
  }

  @Test
  void overTheConnectionCapIs503() throws Exception {
    CountDownLatch release = new CountDownLatch(1);
    CountDownLatch entered = new CountDownLatch(4);
    handler = ex -> {
      entered.countDown();
      try {
        release.await(10, TimeUnit.SECONDS);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
      }
      ex.respond(200, Map.of(), Json.compact(Map.of()));
    };
    List<Socket> held = new ArrayList<>();
    try {
      for (int i = 0; i < 4; i++) {
        Socket s = new Socket(InetAddress.getLoopbackAddress(), server.port());
        s.getOutputStream().write("GET / HTTP/1.1\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
        held.add(s);
      }
      assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
      String response = exchange("GET / HTTP/1.1\r\n\r\n");
      assertThat(status(response)).isEqualTo("HTTP/1.1 503 Service Unavailable");
      assertThat(response).contains("retry-after: 1\r\n");
    } finally {
      release.countDown();
      for (Socket s : held) {
        s.close();
      }
    }
  }

  @Test
  void randomBytesNeverBreakTheServer() throws IOException {
    Random random = new Random(20261007L);
    String[] seeds = {
      "GET / HTTP/1.1\r\nHost: a\r\n\r\n",
      "POST /v1/invoke HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
    };
    for (int i = 0; i < 300; i++) {
      byte[] request;
      if (i % 3 == 0) {
        request = new byte[random.nextInt(200)];
        random.nextBytes(request);
      } else {
        // A valid request with a few bytes flipped, dropped or repeated.
        StringBuilder mutated = new StringBuilder(seeds[i % 2]);
        for (int m = 0; m < 1 + random.nextInt(4); m++) {
          int at = random.nextInt(mutated.length());
          switch (random.nextInt(3)) {
            case 0:
              mutated.setCharAt(at, (char) random.nextInt(256));
              break;
            case 1:
              mutated.deleteCharAt(at);
              break;
            default:
              mutated.insert(at, mutated.charAt(at));
          }
        }
        request = mutated.toString().getBytes(StandardCharsets.ISO_8859_1);
      }
      String response = exchange(request);
      assertThat(response.isEmpty() || response.startsWith("HTTP/1.1 200 ") || response.startsWith("HTTP/1.1 400 ")
          || response.startsWith("HTTP/1.1 408 ")).as("answer #%d: %s", i, status(response)).isTrue();
    }
    assertThat(status(exchange("GET / HTTP/1.1\r\n\r\n"))).isEqualTo("HTTP/1.1 200 OK");
  }
}
