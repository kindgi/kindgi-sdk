// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import org.jspecify.annotations.Nullable;

/**
 * Only the names a pack declares reach its code.
 *
 * <p>Before the pack's code loads, the pack service's environment keeps only the names the pack
 * declares ({@code env.required}, {@code env.optional}), {@code KINDGI_*} (the service's own
 * settings) and the platform's: the process's basics, the language runtime's settings, the port,
 * network trust, and the platform's own workload identity and metadata (Cloud Run, AWS, Azure).
 * Static credentials ({@code AWS_SECRET_ACCESS_KEY}, {@code GOOGLE_APPLICATION_CREDENTIALS},
 * {@code AZURE_CLIENT_SECRET}) aren't among them: a pack that needs one declares it.
 *
 * <p>A JVM can't drop a variable from its own environment, so the launcher ({@code
 * kindgi-pack-java}) does, from {@code KINDGI_PACK_ENV_DECLARED} (the declared names, which a
 * {@code kindgi build} image sets), and hands the JVM the dropped names to log. The service checks
 * the outcome: a name the pack doesn't declare that still reaches it fails the boot. {@code
 * KINDGI_PACK_ENV_FILTER=off} keeps everything ({@code kindgi dev} sets it). The lists are the
 * TypeScript and Python pack services' and the launcher's; the conformance suite checks them all.
 */
final class PackEnv {
  /** {@code on} (default) or {@code off}. */
  static final String FILTER_VAR = "KINDGI_PACK_ENV_FILTER";

  /** The pack's declared names, comma-separated, for the launcher. */
  static final String DECLARED_VAR = "KINDGI_PACK_ENV_DECLARED";

  /** The names the launcher dropped, comma-separated. */
  static final String DROPPED_PROPERTY = "kindgi.pack.envDropped";

  static final Set<String> PLATFORM_ENV_NAMES = Set.of(
      // the process
      "PATH", "HOME", "HOSTNAME", "USER", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TMP", "TEMP", "PWD", "SHLVL",
      "_", "__CF_USER_TEXT_ENCODING",
      // the language runtime (with the version its base image names)
      "NODE_ENV", "NODE_VERSION", "YARN_VERSION", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "JAVA_HOME", "JAVA_VERSION",
      "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS", "VIRTUAL_ENV",
      // the port
      "PORT",
      // network trust
      "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE",
      "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
      // Cloud Run
      "K_SERVICE", "K_REVISION", "K_CONFIGURATION",
      // AWS (ECS, App Runner, EKS)
      "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_EXECUTION_ENV", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN",
      "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN",
      "ECS_CONTAINER_METADATA_URI", "ECS_CONTAINER_METADATA_URI_V4",
      // Azure (Container Apps, managed and workload identity)
      "IDENTITY_ENDPOINT", "IDENTITY_HEADER", "MSI_ENDPOINT", "MSI_SECRET", "AZURE_CLIENT_ID", "AZURE_TENANT_ID",
      "AZURE_FEDERATED_TOKEN_FILE", "AZURE_AUTHORITY_HOST");

  /**
   * The locale, Python's settings, OpenTelemetry's exporter, and Cloud Run's and Container Apps'
   * metadata. {@code KINDGI_*} is kept too.
   */
  static final List<String> PLATFORM_ENV_PREFIXES = List.of("LC_", "PYTHON", "OTEL_", "CLOUD_RUN_", "CONTAINER_APP_");

  /**
   * Names the JVM sets in its own environment once it runs (macOS's {@code java} sets {@code
   * JAVA_MAIN_CLASS_<pid>}): the launcher can't have dropped them, and no operator sets them.
   */
  static final List<String> JVM_OWN_PREFIXES = List.of("JAVA_MAIN_CLASS_", "JAVA_STARTED_ON_FIRST_THREAD_");

  private PackEnv() {}

  /** {@code KINDGI_PACK_ENV_FILTER}'s value ({@code on} when unset or empty), or {@code null} when invalid. */
  static @Nullable String parseFilter(@Nullable String raw) {
    if (raw == null || raw.isEmpty() || raw.equals("on")) {
      return "on";
    }
    return raw.equals("off") ? "off" : null;
  }

  /** The names the index's {@code env} declares, required and optional. */
  static Set<String> declared(@Nullable Object env) {
    Set<String> names = new TreeSet<>();
    if (env instanceof Map) {
      for (String list : List.of("required", "optional")) {
        Object listed = ((Map<?, ?>) env).get(list);
        if (listed instanceof List) {
          for (Object name : (List<?>) listed) {
            names.add(String.valueOf(name));
          }
        }
      }
    }
    return names;
  }

  /**
   * The names in {@code environment} the pack doesn't declare: neither declared, nor {@code
   * KINDGI_*}, nor the platform's. A pack that declares nothing keeps only the last two. Sorted.
   */
  static List<String> undeclared(@Nullable Object env, Map<String, String> environment) {
    Set<String> declared = declared(env);
    List<String> names = new ArrayList<>();
    for (String name : new TreeSet<>(environment.keySet())) {
      if (!declared.contains(name)
          && !name.startsWith("KINDGI_")
          && !PLATFORM_ENV_NAMES.contains(name)
          && PLATFORM_ENV_PREFIXES.stream().noneMatch(name::startsWith)) {
        names.add(name);
      }
    }
    return names;
  }

  /**
   * The names in this JVM's {@code environment} the pack doesn't declare, but for those the JVM set
   * itself ({@link #JVM_OWN_PREFIXES}): after the launcher, none. Sorted.
   */
  static List<String> reachingTheJvm(@Nullable Object env, Map<String, String> environment) {
    List<String> names = new ArrayList<>(undeclared(env, environment));
    names.removeIf(name -> JVM_OWN_PREFIXES.stream().anyMatch(name::startsWith));
    return names;
  }

  /** A comma-separated list of names, without empty entries, in order. */
  static Set<String> names(String commaSeparated) {
    Set<String> names = new LinkedHashSet<>();
    for (String name : commaSeparated.split(",", -1)) {
      if (!name.isEmpty()) {
        names.add(name);
      }
    }
    return names;
  }
}
