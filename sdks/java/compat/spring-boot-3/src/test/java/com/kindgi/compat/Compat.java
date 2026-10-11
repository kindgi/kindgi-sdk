// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.compat;

import static org.assertj.core.api.Assertions.assertThat;

import com.kindgi.client.Kindgi;
import com.kindgi.client.KindgiJson;
import com.kindgi.client.models.EvalBaseline;
import com.kindgi.client.models.LiveScope;
import com.kindgi.client.models.PatchScheduleBody;
import com.kindgi.client.models.Run;
import com.sun.net.httpserver.HttpServer;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** What the client must do in any app, whatever Jackson versions the app's build resolves. */
final class Compat {
  private Compat() {}

  static final UUID RUN_ID = UUID.fromString("6f1c2e1a-1111-4222-8333-944455556666");
  static final String RUN =
      "{\"id\":\"" + RUN_ID + "\",\"tenantId\":\"6f1c2e1a-1111-4222-8333-944455556667\",\"flowId\":\"acme.f\","
          + "\"flowVersion\":\"1\",\"status\":\"paused-for-ever\",\"dryRun\":false,\"createdAt\":\"2026-10-07T10:00:00+02:00\","
          + "\"updatedAt\":\"2026-10-07T10:00:01Z\",\"newField\":true}";

  /** The client's own (shaded) codec, through KindgiJson. */
  static void clientRoundTrips() {
    Run run = KindgiJson.read(RUN, Run.class);
    assertThat(run.status().value()).isEqualTo(Run.Status.Value.UNRECOGNIZED);
    assertThat(run.createdAt().getOffset().getTotalSeconds()).isEqualTo(7200);
    assertThat(KindgiJson.read("{\"kind\":\"galaxy\"}", LiveScope.class)).isInstanceOf(LiveScope.Unrecognized.class);
    assertThat(KindgiJson.read("\"recorded\"", EvalBaseline.class)).isEqualTo(EvalBaseline.RECORDED);
    assertThat(KindgiJson.read("{\"live\":{}}", EvalBaseline.class)).isInstanceOf(EvalBaseline.WithLive.class);
    assertThat(KindgiJson.write(PatchScheduleBody.builder().label(null).build())).isEqualTo("{\"label\":null}");
  }

  static void clientCallsAServer() throws Exception {
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext("/", ex -> {
      byte[] body = RUN.getBytes(StandardCharsets.UTF_8);
      ex.sendResponseHeaders(200, body.length);
      try (OutputStream out = ex.getResponseBody()) {
        out.write(body);
      }
    });
    server.start();
    try {
      Kindgi client = Kindgi.builder().baseUrl("http://127.0.0.1:" + server.getAddress().getPort()).token("kgi_test").build();
      assertThat(client.runs().get(RUN_ID).id()).isEqualTo(RUN_ID);
    } finally {
      server.stop(0);
    }
  }

  /** The Jackson jars the app resolved, and where the client's own Jackson is. */
  static String versions() throws ClassNotFoundException {
    return "app's jackson-annotations " + version(com.fasterxml.jackson.annotation.JsonProperty.class)
        + ", client's Jackson in " + version(Class.forName("com.kindgi.client.internal.shaded.jackson.databind.ObjectMapper"));
  }

  private static String version(Class<?> c) {
    String path = c.getProtectionDomain().getCodeSource().getLocation().getPath();
    return path.substring(path.lastIndexOf('/') + 1);
  }
}
