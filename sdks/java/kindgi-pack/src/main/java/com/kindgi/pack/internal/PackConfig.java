// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * A JVM pack's config: its {@code kindgi.config.json}. Same keys as {@code kindgi.config.ts} and
 * Python's {@code [tool.kindgi]}, plus the language:
 *
 * <pre>{@code
 * {
 *   "language": "java",
 *   "pack": { "id": "acme.ledger", "version": "1.0.0" },
 *   "discovery": { "tools": "src/main/java/**\/tools/**\/*.java" },
 *   "env": { "required": ["DATABASE_URL"], "optional": ["SENTRY_DSN"] }
 * }
 * }</pre>
 *
 * @param path the file
 * @param id {@code pack.id}
 * @param version {@code pack.version}
 * @param description {@code pack.description}
 * @param discovery the discovery globs by folder ({@code tools}, {@code guardrails}, {@code
 *     agents}, {@code flows}), defaults filled in
 * @param env the process env the pack service needs; {@code null} when it names none
 * @param raw the whole file
 */
public record PackConfig(
    Path path,
    String id,
    String version,
    @Nullable String description,
    Map<String, String> discovery,
    @Nullable Env env,
    Map<String, Object> raw) {

  /** The config's file name. */
  public static final String FILE_NAME = "kindgi.config.json";

  /** The language a Java pack names. */
  public static final String LANGUAGE = "java";

  /** The discovery globs when the config doesn't set them. */
  public static final Map<String, String> DEFAULT_DISCOVERY;

  static {
    Map<String, String> d = new LinkedHashMap<>();
    for (String folder : List.of("tools", "guardrails", "agents", "flows")) {
      d.put(folder, "src/main/java/**/" + folder + "/**/*.java");
    }
    DEFAULT_DISCOVERY = java.util.Collections.unmodifiableMap(d);
  }

  private static final Pattern ENV_NAME = Pattern.compile("[A-Za-z_][A-Za-z0-9_]*");
  private static final String RESERVED_ENV_PREFIX = "KINDGI_";

  /**
   * The {@code env} key: the process env the pack service needs ({@code required}) or reads when
   * set ({@code optional}), each sorted (code-unit order).
   *
   * @param required names that must be set and non-empty for the service to be ready
   * @param optional names read when set
   */
  public record Env(List<String> required, List<String> optional) {}

  /** The config can't be read, or says something wrong. */
  public static final class ConfigException extends Exception {
    private static final long serialVersionUID = 1L;
    private final String code;
    private final transient @Nullable Path path;
    private final @Nullable String field;

    ConfigException(String code, String message, @Nullable Path path, @Nullable String field) {
      super(message);
      this.code = code;
      this.path = path;
      this.field = field;
    }

    /** @return {@code config-not-found}, {@code config-parse-failed} or {@code config-invalid} */
    public String code() {
      return code;
    }

    /** @return the config file, when there is one */
    public @Nullable Path path() {
      return path;
    }

    /** @return the key at fault, when one is ({@code env}) */
    public @Nullable String field() {
      return field;
    }
  }

  /**
   * Reads and minimally checks the config.
   *
   * @param packDir the pack's root
   * @param configPath the file, when it isn't {@code <packDir>/kindgi.config.json}
   * @return the config
   * @throws ConfigException when it's missing or wrong
   */
  @SuppressWarnings("unchecked")
  public static PackConfig load(Path packDir, @Nullable Path configPath) throws ConfigException {
    Path path = (configPath != null ? configPath : packDir.resolve(FILE_NAME)).toAbsolutePath().normalize();
    if (!Files.isRegularFile(path)) {
      throw new ConfigException("config-not-found", "No " + FILE_NAME + " found at pack root " + packDir, null, null);
    }
    Object document;
    try {
      document = Json.parse(Files.readAllBytes(path));
    } catch (IOException | RuntimeException cause) {
      throw new ConfigException("config-parse-failed", "Failed to read " + path + ": " + cause.getMessage(), path, null);
    }
    if (!(document instanceof Map)) {
      throw parseFailed(path, "the file must hold a JSON object");
    }
    Map<String, Object> raw = (Map<String, Object>) document;
    Object language = raw.get("language");
    if (!LANGUAGE.equals(language)) {
      throw parseFailed(path, language == null
          ? "'language' is missing; a Java pack says \"language\": \"java\""
          : "'language' is " + Json.compactString(language) + "; this indexer reads Java packs (\"java\")");
    }
    if (!(raw.get("pack") instanceof Map)) {
      throw parseFailed(path, "'pack' field is missing or not an object");
    }
    Map<String, Object> pack = (Map<String, Object>) raw.get("pack");
    if (!(pack.get("id") instanceof String) || ((String) pack.get("id")).isEmpty()) {
      throw parseFailed(path, "'pack.id' is missing or not a non-empty string");
    }
    if (!(pack.get("version") instanceof String) || ((String) pack.get("version")).isEmpty()) {
      throw parseFailed(path, "'pack.version' is missing or not a non-empty string");
    }
    Object discovery = raw.getOrDefault("discovery", Map.of());
    if (!(discovery instanceof Map) || !((Map<String, Object>) discovery).values().stream().allMatch(v -> v instanceof String)) {
      throw parseFailed(path, "'discovery' must map kinds to glob strings");
    }
    Map<String, String> globs = new LinkedHashMap<>(DEFAULT_DISCOVERY);
    ((Map<String, Object>) discovery).forEach((k, v) -> globs.put(k, (String) v));
    Object description = pack.get("description");
    return new PackConfig(
        path,
        (String) pack.get("id"),
        (String) pack.get("version"),
        description instanceof String ? (String) description : null,
        java.util.Collections.unmodifiableMap(globs),
        env(raw.get("env"), path),
        raw);
  }

  private static ConfigException parseFailed(Path path, String message) {
    return new ConfigException("config-parse-failed", "Config file " + path + ": " + message, path, null);
  }

  /** The rules and messages of the TypeScript {@code resolvePackEnv} and Python's {@code _env}. */
  @SuppressWarnings("unchecked")
  private static @Nullable Env env(@Nullable Object table, Path path) throws ConfigException {
    if (table == null) {
      return null;
    }
    if (!(table instanceof Map)) {
      throw invalid(path, "`env` must be an object: {\"required\": [...], \"optional\": [...]}");
    }
    Map<String, Object> entries = (Map<String, Object>) table;
    List<String> unknown = new ArrayList<>();
    for (String key : entries.keySet()) {
      if (!key.equals("required") && !key.equals("optional")) {
        unknown.add("`" + key + "`");
      }
    }
    if (!unknown.isEmpty()) {
      throw invalid(path, "`env` takes only `required` and `optional`, not " + String.join(", ", unknown));
    }
    List<String> problems = new ArrayList<>();
    Map<String, String> seen = new LinkedHashMap<>();
    Map<String, List<String>> lists = new LinkedHashMap<>();
    lists.put("required", new ArrayList<>());
    lists.put("optional", new ArrayList<>());
    for (String key : List.of("required", "optional")) {
      Object names = entries.get(key);
      if (names == null) {
        continue;
      }
      if (!(names instanceof List) || !((List<Object>) names).stream().allMatch(n -> n instanceof String)) {
        problems.add("`env." + key + "` must be a list of names");
        continue;
      }
      for (Object n : (List<Object>) names) {
        String name = (String) n;
        String quoted = Json.compactString(name);
        if (!ENV_NAME.matcher(name).matches()) {
          problems.add(quoted + " in `env." + key + "` isn't an environment variable name");
        } else if (name.startsWith(RESERVED_ENV_PREFIX)) {
          problems.add(quoted + " in `env." + key + "`: `" + RESERVED_ENV_PREFIX + "*` names configure Kindgi, not the pack");
        } else if (seen.containsKey(name)) {
          problems.add(seen.get(name).equals(key)
              ? quoted + " is listed twice in `env." + key + "`"
              : quoted + " is in both `env.required` and `env.optional`");
        } else {
          seen.put(name, key);
          lists.get(key).add(name);
        }
      }
    }
    if (!problems.isEmpty()) {
      throw invalid(path, String.join("; ", problems));
    }
    if (seen.isEmpty()) {
      return null;
    }
    List<String> required = new ArrayList<>(lists.get("required"));
    List<String> optional = new ArrayList<>(lists.get("optional"));
    required.sort(null);
    optional.sort(null);
    return new Env(List.copyOf(required), List.copyOf(optional));
  }

  private static ConfigException invalid(Path path, String message) {
    return new ConfigException("config-invalid", "Config file " + path + ": " + message, path, "env");
  }
}
