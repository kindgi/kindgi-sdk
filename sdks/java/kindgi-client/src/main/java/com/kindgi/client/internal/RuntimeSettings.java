// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.internal;

import java.io.IOException;
import java.lang.System.Logger.Level;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.jspecify.annotations.Nullable;

/**
 * Where a client finds its Kindgi runtime when it's given no URL or token. The same rules as the
 * TypeScript SDK's {@code createClient()} and the Python client:
 *
 * <ol>
 *   <li>the builder's {@code baseUrl} and {@code token};
 *   <li>{@code KINDGI_API_URL} and {@code KINDGI_API_TOKEN} from the environment;
 *   <li>outside production, the running {@code kindgi dev}, from the nearest {@code
 *       .kindgirc.json} at or above the working directory, with a one-time warning to put them in
 *       the app's env file;
 *   <li>otherwise, an error that says what to set.
 * </ol>
 *
 * Production ({@code KINDGI_ENV} or {@code NODE_ENV} set to {@code production}) never reads
 * {@code .kindgirc.json}. Whatever the source, a token that differs from the running {@code
 * kindgi dev}'s for the same URL (the stale token after {@code kindgi dev --reset}) is warned
 * about once.
 */
public final class RuntimeSettings {
  private RuntimeSettings() {}

  /** The file {@code kindgi dev} writes in the pack directory. */
  public static final String DEV_RUNTIME_FILE = ".kindgirc.json";

  private static final String ENV_FILE_HINT = "your env file (.env / .env.local)";
  private static final Set<String> WARNED = ConcurrentHashMap.newKeySet();
  private static final System.Logger LOG = System.getLogger("com.kindgi.client");

  /**
   * A resolved URL and token.
   *
   * @param baseUrl the runtime's URL
   * @param token the API token
   */
  public record Settings(String baseUrl, String token) {}

  /** A running {@code kindgi dev}. */
  record DevRuntime(String apiUrl, String token, Path path) {}

  /**
   * Resolves what's missing, from the process environment and working directory.
   *
   * @param baseUrl the given URL, or {@code null}
   * @param token the given token, or {@code null}
   * @return the settings
   * @throws IllegalStateException when no URL or no token can be found
   */
  public static Settings resolve(@Nullable String baseUrl, @Nullable String token) {
    return resolve(baseUrl, token, System.getenv(), Path.of("").toAbsolutePath());
  }

  static Settings resolve(@Nullable String baseUrl, @Nullable String token, Map<String, String> env, Path cwd) {
    DevRuntime dev = isProduction(env) ? null : findDevRuntime(cwd);
    String url = nonEmpty(baseUrl) != null ? baseUrl : nonEmpty(env.get("KINDGI_API_URL"));
    String secret = nonEmpty(token) != null ? token : nonEmpty(env.get("KINDGI_API_TOKEN"));
    if ((url == null || secret == null) && dev != null) {
      List<String> used = new ArrayList<>();
      if (url == null) {
        url = dev.apiUrl();
        used.add("KINDGI_API_URL");
      }
      if (secret == null) {
        secret = dev.token();
        used.add("KINDGI_API_TOKEN");
      }
      warnOnce(
          "fallback:" + dev.path(),
          "Using the running kindgi dev from " + dev.path() + " for " + String.join(" and ", used) + ". Set them in "
              + ENV_FILE_HINT + ", and in production, where there's no " + DEV_RUNTIME_FILE + ".");
    }
    if (url == null || secret == null) {
      List<String> missing = new ArrayList<>();
      if (url == null) {
        missing.add("KINDGI_API_URL");
      }
      if (secret == null) {
        missing.add("KINDGI_API_TOKEN");
      }
      boolean one = missing.size() == 1;
      String hint =
          isProduction(env)
              ? ""
              : " In development, run `kindgi dev` in the app: it writes them to " + DEV_RUNTIME_FILE + ", which the client reads.";
      throw new IllegalStateException(
          "Kindgi: " + String.join(" and ", missing) + (one ? " isn't" : " aren't") + " set. Set " + (one ? "it" : "them") + " in "
              + ENV_FILE_HINT + ", or pass baseUrl and token to the builder." + hint);
    }
    if (dev != null && !secret.equals(dev.token()) && sameUrl(url, dev.apiUrl())) {
      warnOnce(
          "stale:" + dev.path() + ":" + dev.token(),
          "The API token doesn't match the running kindgi dev's (" + dev.path() + "). After `kindgi dev --reset` the token"
              + " changes: copy the new one into " + ENV_FILE_HINT + ".");
    }
    return new Settings(url, secret);
  }

  static boolean isProduction(Map<String, String> env) {
    return "production".equals(env.get("KINDGI_ENV")) || "production".equals(env.get("NODE_ENV"));
  }

  /** The running {@code kindgi dev}'s URL and token, from the nearest {@code .kindgirc.json}. */
  static @Nullable DevRuntime findDevRuntime(Path start) {
    for (Path dir = start; dir != null; dir = dir.getParent()) {
      Path candidate = dir.resolve(DEV_RUNTIME_FILE);
      if (Files.isRegularFile(candidate)) {
        return read(candidate);
      }
    }
    return null;
  }

  private static @Nullable DevRuntime read(Path file) {
    try {
      Object parsed = Json.mapper().readValue(Files.readString(file, StandardCharsets.UTF_8), Object.class);
      if (!(parsed instanceof Map)) {
        return null;
      }
      Object apiUrl = ((Map<?, ?>) parsed).get("apiUrl");
      Object token = ((Map<?, ?>) parsed).get("token");
      if (!(apiUrl instanceof String) || ((String) apiUrl).isEmpty() || !(token instanceof String) || ((String) token).isEmpty()) {
        return null;
      }
      return new DevRuntime((String) apiUrl, (String) token, file);
    } catch (IOException | RuntimeException e) {
      return null;
    }
  }

  private static boolean sameUrl(String a, String b) {
    return strip(a).equals(strip(b));
  }

  private static String strip(String url) {
    return url.endsWith("/") ? strip(url.substring(0, url.length() - 1)) : url;
  }

  private static @Nullable String nonEmpty(@Nullable String s) {
    return s == null || s.isEmpty() ? null : s;
  }

  private static void warnOnce(String key, String message) {
    if (WARNED.add(key)) {
      LOG.log(Level.WARNING, "[kindgi] " + message);
    }
  }

  /** Tests only: forget which warnings were shown. */
  static void resetWarnings() {
    WARNED.clear();
  }
}
