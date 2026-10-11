// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import static org.assertj.core.api.Assertions.assertThat;

import com.kindgi.pack.internal.Json;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Only the names a pack declares reach its code: the launcher drops the rest before the JVM starts,
 * and the service logs their names, or fails its boot when one still reaches it. The conformance
 * suite checks the same black-box, for every pack service.
 */
class PackEnvTest {
  private static final Map<String, Object> DECLARED = Map.of("required", List.of("A_URL"), "optional", List.of("CACHE_DIR"));

  @TempDir Path dir;

  @Test
  void undeclaredGoDeclaredKindgiAndPlatformStay() {
    Map<String, String> env = new HashMap<>();
    for (String name : List.of("A_URL", "CACHE_DIR", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "DATABASE_URL",
        "KINDGI_LOG_FORMAT", "PATH", "PORT", "JDK_JAVA_OPTIONS", "LC_ALL", "PYTHONPATH", "OTEL_EXPORTER_OTLP_ENDPOINT",
        "K_SERVICE", "CONTAINER_APP_NAME", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "IDENTITY_ENDPOINT")) {
      env.put(name, "x");
    }
    assertThat(PackEnv.undeclared(DECLARED, env)).containsExactly("ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "DATABASE_URL");
    // Declaring nothing keeps only Kindgi's and the platform's.
    assertThat(PackEnv.undeclared(null, env))
        .containsExactly("ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "A_URL", "CACHE_DIR", "DATABASE_URL");
  }

  @Test
  void theFilterSetting() {
    assertThat(PackEnv.parseFilter(null)).isEqualTo("on");
    assertThat(PackEnv.parseFilter("")).isEqualTo("on");
    assertThat(PackEnv.parseFilter("on")).isEqualTo("on");
    assertThat(PackEnv.parseFilter("off")).isEqualTo("off");
    assertThat(PackEnv.parseFilter("no")).isNull();
    Object problems = Serve.readConfig(List.of(), Map.of("KINDGI_PACK_SERVICE_TOKEN", "t", PackEnv.FILTER_VAR, "no"), null);
    assertThat(problems).isEqualTo(List.of("KINDGI_PACK_ENV_FILTER must be `on` or `off`, not \"no\""));
  }

  @Test
  void theLauncherKeepsTheServicesLists() throws IOException {
    String script = launcher();
    int start = script.indexOf("split(\"PATH ");
    int end = script.indexOf("\", names, \" \")", start);
    assertThat(start).isPositive();
    assertThat(end).isPositive();
    // The awk string is split over lines: `" \` then `" ` on the next.
    String joined = script.substring(start + "split(\"".length(), end).replaceAll("\"\\s*\\\\\\n\\s*\"", "");
    assertThat(new TreeSet<>(Arrays.asList(joined.trim().split("\\s+")))).isEqualTo(new TreeSet<>(PackEnv.PLATFORM_ENV_NAMES));
    Matcher prefixes = Pattern.compile("name ~ /\\^\\(([^)]*)\\)/").matcher(script);
    assertThat(prefixes.find()).isTrue();
    List<String> expected = new ArrayList<>(List.of("KINDGI_"));
    expected.addAll(PackEnv.PLATFORM_ENV_PREFIXES);
    assertThat(prefixes.group(1).split("\\|")).containsExactlyElementsOf(expected);
  }

  @Test
  void theLauncherDropsTheUndeclaredBeforeTheJvmStarts() throws Exception {
    Map<String, String> out = runProbe(Map.of(PackEnv.DECLARED_VAR, "A_URL,CACHE_DIR", "A_URL", "postgres://db",
        "ACME_UNDECLARED_KEY", "fake-not-a-key", "OTEL_SERVICE_NAME", "pack"));
    Set<String> names = Set.of(out.get("names").split(","));
    assertThat(names).contains("A_URL", "OTEL_SERVICE_NAME", PackEnv.DECLARED_VAR).doesNotContain("ACME_UNDECLARED_KEY");
    assertThat(out.get("dropped").split(",")).contains("ACME_UNDECLARED_KEY").doesNotContain("A_URL");
    assertThat(out.get("dropped")).doesNotContain("fake-not-a-key");
    // Whatever this test runs under, the JVM sees only what the service allows.
    assertThat(PackEnv.reachingTheJvm(DECLARED, toMap(names))).isEmpty();
  }

  @Test
  void theLauncherDropsNothingWhenOffOrWithoutTheDeclaredNames() throws Exception {
    Map<String, String> off = runProbe(Map.of(PackEnv.FILTER_VAR, "off", PackEnv.DECLARED_VAR, "A_URL",
        "ACME_UNDECLARED_KEY", "fake-not-a-key"));
    assertThat(off.get("names").split(",")).contains("ACME_UNDECLARED_KEY");
    assertThat(off.get("dropped")).isEqualTo("null");
    Map<String, String> unlisted = runProbe(Map.of("ACME_UNDECLARED_KEY", "fake-not-a-key"));
    assertThat(unlisted.get("names").split(",")).contains("ACME_UNDECLARED_KEY");
  }

  @Test
  void theServiceLogsTheDroppedNames() throws IOException {
    List<Map<String, Object>> records = new CopyOnWriteArrayList<>();
    Object loaded = Serve.load(config("on"), Map.of("A_URL", "postgres://db", PackEnv.DECLARED_VAR, "A_URL,CACHE_DIR"),
        "ZETA_KEY,ACME_UNDECLARED_KEY", getClass().getClassLoader(), logs(records));
    assertThat(loaded).isInstanceOf(PackService.class);
    ((PackService) loaded).close();
    Map<String, Object> dropped = records.stream().filter(r -> "env-dropped".equals(r.get("event"))).findFirst().orElseThrow();
    assertThat(dropped).containsEntry("level", "warn").containsEntry("kind", "env-dropped")
        .containsEntry("names", List.of("ACME_UNDECLARED_KEY", "ZETA_KEY")).containsEntry("packId", "acme");
  }

  @Test
  void anUndeclaredNameThatReachesTheServiceFailsTheBoot() throws IOException {
    Object loaded = Serve.load(config("on"), Map.of("A_URL", "x", "ACME_UNDECLARED_KEY", "fake-not-a-key"), null,
        getClass().getClassLoader(), logs(new ArrayList<>()));
    assertThat(loaded).isInstanceOf(List.class);
    assertThat(loaded.toString()).contains("ACME_UNDECLARED_KEY", "kindgi-pack-java", "KINDGI_PACK_ENV_FILTER=off")
        .doesNotContain("fake-not-a-key");
    // Off, it reaches the pack, as before.
    Object off = Serve.load(config("off"), Map.of("A_URL", "x", "ACME_UNDECLARED_KEY", "fake-not-a-key"), null,
        getClass().getClassLoader(), logs(new ArrayList<>()));
    assertThat(off).isInstanceOf(PackService.class);
    ((PackService) off).close();
  }

  @Test
  void aLauncherListThatIsntTheDeclaredEnvFailsTheBoot() throws IOException {
    Object loaded = Serve.load(config("on"), Map.of("A_URL", "x", PackEnv.DECLARED_VAR, "A_URL"), null,
        getClass().getClassLoader(), logs(new ArrayList<>()));
    assertThat(loaded).asString().contains("KINDGI_PACK_ENV_DECLARED (\"A_URL\") isn't the pack's declared env (\"A_URL,CACHE_DIR\")");
  }

  private Serve.Config config(String envFilter) throws IOException {
    Path index = dir.resolve("index.json");
    Files.writeString(index, "{\"v\":1,\"packId\":\"acme\",\"packVersion\":\"1.0.0\",\"artifactVersion\":\"20261010.1\","
        + "\"tools\":[],\"guardrails\":[],\"env\":{\"optional\":[\"CACHE_DIR\"],\"required\":[\"A_URL\"]}}");
    return new Serve.Config(index, "t", 0, null, 1, "warn", envFilter);
  }

  @SuppressWarnings("unchecked")
  private static PackLogs logs(List<Map<String, Object>> records) {
    PackLogs.Outcome built = PackLogs.fromEnv(Map.of("KINDGI_LOG_FORMAT", "json"), line -> {
      try {
        records.add((Map<String, Object>) Json.parse(line.getBytes(StandardCharsets.UTF_8)));
      } catch (IOException e) {
        throw new AssertionError("not a JSON record: " + line, e);
      }
    }, false);
    return ((PackLogs.Ok) built).logs();
  }

  private static String launcher() throws IOException {
    try (var in = PackService.class.getResourceAsStream("kindgi-pack-java")) {
      assertThat(in).isNotNull();
      return new String(in.readAllBytes(), StandardCharsets.UTF_8);
    }
  }

  /** {@link EnvProbe} through the launcher, with {@code env} added to this test's environment. */
  private static Map<String, String> runProbe(Map<String, String> env) throws Exception {
    Path launcher = Path.of(PackService.class.getResource("kindgi-pack-java").toURI());
    ProcessBuilder pb = new ProcessBuilder("sh", launcher.toString(), "-cp", System.getProperty("java.class.path"),
        "com.kindgi.pack.EnvProbe");
    pb.environment().remove(PackEnv.FILTER_VAR);
    pb.environment().remove(PackEnv.DECLARED_VAR);
    pb.environment().put("JAVA_HOME", System.getProperty("java.home"));
    pb.environment().putAll(env);
    pb.redirectErrorStream(true);
    Process p = pb.start();
    String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    assertThat(p.waitFor()).as(out).isEqualTo(0);
    Map<String, String> lines = new HashMap<>();
    for (String line : out.split("\n")) {
      int eq = line.indexOf('=');
      if (eq > 0) {
        lines.put(line.substring(0, eq), line.substring(eq + 1));
      }
    }
    assertThat(lines).as(out).containsKeys("names", "dropped");
    return lines;
  }

  private static Map<String, String> toMap(Set<String> names) {
    Map<String, String> map = new HashMap<>();
    for (String name : names) {
      map.put(name, "x");
    }
    return map;
  }
}
