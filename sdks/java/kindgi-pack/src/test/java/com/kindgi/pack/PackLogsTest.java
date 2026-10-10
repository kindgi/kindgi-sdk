// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import static org.assertj.core.api.Assertions.assertThat;

import com.kindgi.log.Logger;
import com.kindgi.pack.internal.Json;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The pack service's two streams: the lifecycle, whatever the levels, and calls at the levels set. */
class PackLogsTest {
  private final List<String> lines = new ArrayList<>();

  private PackLogs logs(Map<String, String> env, boolean isTTY) {
    PackLogs.Outcome built = PackLogs.fromEnv(env, lines::add, isTTY);
    assertThat(built).isInstanceOf(PackLogs.Ok.class);
    return ((PackLogs.Ok) built).logs();
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> parse(String line) throws IOException {
    return (Map<String, Object>) Json.parse(line.getBytes(StandardCharsets.UTF_8));
  }

  @Test
  void theLifecycleIsWrittenWhateverTheLevelsWithKindBesideEvent() throws IOException {
    PackLogs logs = logs(Map.of("KINDGI_LOG_LEVEL", "error"), false);
    logs.event(PackLogs.Event.LISTENING, "Listening on port 8080", Map.of("port", 8080, "packId", "acme"));
    logs.log().info("tool acme.lookup ok 3ms");
    logs.event(PackLogs.Event.STOPPED, "Stopped");
    assertThat(lines).hasSize(2);
    assertThat(parse(lines.get(0))).containsEntry("level", "info").containsEntry("subsystem", "pack")
        .containsEntry("message", "Listening on port 8080").containsEntry("port", 8080).containsEntry("packId", "acme")
        .containsEntry("event", "listening").containsEntry("kind", "listening");
    assertThat(parse(lines.get(1))).containsEntry("event", "stopped").containsEntry("kind", "stopped");
  }

  @Test
  void aFailureToBootIsAnError() throws IOException {
    logs(Map.of(), false).event(PackLogs.Event.BOOT_FAILED, "The pack service failed to boot",
        Map.of("problems", List.of("Missing module: x")));
    assertThat(parse(lines.get(0))).containsEntry("level", "error").containsEntry("severity", "ERROR")
        .containsEntry("problems", List.of("Missing module: x")).containsEntry("kind", "boot-failed");
  }

  @Test
  void devModeDoesntMakeItPrettyButATerminalDoes() throws IOException {
    logs(Map.of("KINDGI_DEV", "true"), false).event(PackLogs.Event.DRAINING, "Draining: finishing the calls in flight");
    assertThat(parse(lines.get(0))).containsEntry("kind", "draining");
    lines.clear();
    logs(Map.of("NO_COLOR", "1"), true).log().info("hello");
    assertThat(lines.get(0)).matches("\\d\\d:\\d\\d:\\d\\d\\.\\d{3} INFO  \\[pack\\] hello");
  }

  @Test
  void aBadSettingIsRefusedNamingItAndAnUnknownSubsystemIsAProblem() {
    assertThat(PackLogs.fromEnv(Map.of("KINDGI_LOG_LEVEL", "loud"), lines::add, false)).isEqualTo(
        new PackLogs.Err("KINDGI_LOG_LEVEL must be one of error, warn, info, debug, trace, got \"loud\"."));
    PackLogs.Outcome typo = PackLogs.fromEnv(Map.of("KINDGI_LOG_LEVELS", "pakc=debug"), lines::add, false);
    assertThat(((PackLogs.Ok) typo).problems())
        .containsExactly("KINDGI_LOG_LEVELS names \"pakc\", which no subsystem logs under; it has no effect.");
  }

  @Test
  void aDrainStopsTakingCallsBeforeItSaysSo() {
    Map<String, Object> index = Map.of("v", 1, "packId", "acme", "packVersion", "1.0.0", "artifactVersion", "1");
    PackService service = new PackService(index, "t0ken", 4, "strict", Map.of(), Logger.noop());
    List<Boolean> drainingWhenSaid = new ArrayList<>();
    PackLogs.Outcome built = PackLogs.fromEnv(Map.of(), line -> {
      if (line.contains("\"event\":\"draining\"")) {
        drainingWhenSaid.add(service.draining());
      }
    }, false);
    Serve.beginDraining(service, ((PackLogs.Ok) built).logs());
    // A supervisor that reads the record and asks readyz at once must already get 503.
    assertThat(drainingWhenSaid).containsExactly(true);
  }

  @Test
  void theProcessRefusesABadLogSettingWithAConfigInvalidRecord() throws Exception {
    Path java = Path.of(System.getProperty("java.home"), "bin", "java");
    ProcessBuilder pb = new ProcessBuilder(java.toString(), "-cp", System.getProperty("java.class.path"),
        "com.kindgi.pack.Main", "serve");
    pb.environment().put("KINDGI_LOG_LEVEL", "loud");
    pb.environment().remove("KINDGI_PACK_SERVICE_TOKEN");
    pb.redirectInput(ProcessBuilder.Redirect.PIPE);
    Process p = pb.start();
    p.getOutputStream().close();
    String err = new String(p.getErrorStream().readAllBytes(), StandardCharsets.UTF_8);
    assertThat(p.waitFor()).as(err).isEqualTo(1);
    Map<String, Object> record = parse(err.strip());
    assertThat(record).containsEntry("event", "config-invalid").containsEntry("kind", "config-invalid")
        .containsEntry("level", "error").containsEntry("subsystem", "pack")
        .containsEntry("problems", List.of("KINDGI_LOG_LEVEL must be one of error, warn, info, debug, trace, got \"loud\"."));
  }
}
