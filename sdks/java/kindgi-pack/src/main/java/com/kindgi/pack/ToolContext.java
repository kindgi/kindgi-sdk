// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.kindgi.log.Logger;
import java.util.AbstractMap;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/**
 * A tool call's context, as the runtime sends it (pack protocol v2's call context), plus its
 * {@link #cancellation()} and its {@link #log()}.
 *
 * @param tenantId the tenant the call runs for
 * @param runId the run the call belongs to
 * @param requestId the individual call (a model's tool-call id), when sent
 * @param projectId the run's project, when sent (set by the runtime, never from input)
 * @param orgId the project's org, when it has one
 * @param env resolved environment values for the call
 * @param secrets resolved secrets for the call, by name (the tool's declared secrets); an optional one
 *     (its schema names null) is absent when the env doesn't have it, or has it empty (runtime 0.1.6 or
 *     later); printing
 *     them, or the context, shows their names, never their values, and the context's JSON leaves them out
 * @param config resolved configuration for the call
 * @param settings the settings blocks the calling agent version pins, by block id
 * @param cancellation fires when the call passes its deadline or its caller goes away
 * @param log a logger bound to this call: its records carry the run's ids and the caller's trace id
 *     ({@code ctx.log().info("looked up order", Map.of("orderId", orderId))}). The pack service sets
 *     it; {@link #forTest()}'s writes nothing. A secret's value is never a field (the logger redacts
 *     secret-looking keys and shapes, but don't rely on it). Never in the context's JSON.
 * @param idempotencyKey a key for this call's side effects: the same every time this call runs (its
 *     step resumed after a wait, retried after a failure, or run again after a crash), different for
 *     every other call. A step can run more than once, so a tool that changes something passes it to
 *     the system it writes to (an {@code Idempotency-Key} header, a client reference, a unique
 *     column), or looks for it there first. A UUID. {@code null} from a runtime that can't name its
 *     steps (before pack protocol 2.6.0): the call can't be deduped on it then.
 */
public record ToolContext(
    String tenantId,
    String runId,
    @Nullable String requestId,
    @Nullable String projectId,
    @Nullable String orgId,
    Map<String, Object> env,
    @JsonIgnore Map<String, Object> secrets,
    Map<String, Object> config,
    Map<String, Map<String, Object>> settings,
    Cancellation cancellation,
    @JsonIgnore Logger log,
    @Nullable String idempotencyKey) {
  /** Copies the maps, unmodifiable. */
  public ToolContext {
    Objects.requireNonNull(tenantId, "tenantId");
    Objects.requireNonNull(runId, "runId");
    env = Collections.unmodifiableMap(new LinkedHashMap<>(env));
    secrets = new Hidden(secrets);
    config = Collections.unmodifiableMap(new LinkedHashMap<>(config));
    settings = Collections.unmodifiableMap(new LinkedHashMap<>(settings));
    Objects.requireNonNull(cancellation, "cancellation");
    Objects.requireNonNull(log, "log");
  }

  /**
   * A context without an idempotency key: the components before pack protocol 2.6.0, so code that
   * built one before keeps compiling.
   *
   * @param tenantId the tenant the call runs for
   * @param runId the run the call belongs to
   * @param requestId the individual call, when sent
   * @param projectId the run's project, when sent
   * @param orgId the project's org, when it has one
   * @param env resolved environment values for the call
   * @param secrets resolved secrets for the call, by name
   * @param config resolved configuration for the call
   * @param settings the settings blocks the calling agent version pins, by block id
   * @param cancellation fires when the call passes its deadline or its caller goes away
   * @param log a logger bound to this call
   */
  public ToolContext(
      String tenantId,
      String runId,
      @Nullable String requestId,
      @Nullable String projectId,
      @Nullable String orgId,
      Map<String, Object> env,
      Map<String, Object> secrets,
      Map<String, Object> config,
      Map<String, Map<String, Object>> settings,
      Cancellation cancellation,
      Logger log) {
    this(tenantId, runId, requestId, projectId, orgId, env, secrets, config, settings, cancellation, log, null);
  }

  /**
   * A context for a unit test of a handler.
   *
   * @return a context with a test tenant and run, a logger that writes nothing, and nothing else
   */
  public static ToolContext forTest() {
    return new ToolContext("t-test", "run-test", null, null, null, Map.of(), Map.of(), Map.of(), Map.of(),
        new Cancellation(), Logger.noop());
  }

  /**
   * A context for a unit test of a handler that logs.
   *
   * @param log the logger the handler's {@link #log()} writes to
   * @return a context with a test tenant and run, the logger, and nothing else
   */
  public static ToolContext forTest(Logger log) {
    return new ToolContext("t-test", "run-test", null, null, null, Map.of(), Map.of(), Map.of(), Map.of(),
        new Cancellation(), log);
  }

  /**
   * A context for a unit test, from a {@link Builder}: its tenant, run, env, secrets, config and
   * logger as the builder set them, each unset one a test default ({@code "t-test"}, {@code
   * "run-test"}, nothing, a logger that writes nothing).
   *
   * @param builder the builder
   * @return the context
   */
  public static ToolContext forTest(Builder builder) {
    return new ToolContext(builder.tenantId, builder.runId, builder.requestId, builder.projectId,
        builder.orgId, builder.env, builder.secrets, builder.config, builder.settings,
        builder.cancellation, builder.log, builder.idempotencyKey);
  }

  /**
   * A context for a unit test of a handler whose tool declares {@code needsSpec.env}: every env
   * name the tool declares, taken from {@code env} or the schema's string default and checked
   * against its schema, so a test exercises the same env resolution the runtime does. A name the
   * tool doesn't declare is dropped. Secrets are passed through as given — the SDK doesn't check
   * them (the runtime does).
   *
   * @param tool the tool whose {@code needsSpec} to read
   * @param env the env a test offers, by name; {@code null} for none
   * @param secrets the secrets to pass through, by name; {@code null} for none
   * @return the context
   * @throws IllegalStateException when a declared env value is missing (no given value and no
   *     string default), doesn't match its schema, or is declared with a schema that doesn't
   *     compile
   */
  public static ToolContext forTest(
      Tool<?, ?> tool, @Nullable Map<String, String> env, @Nullable Map<String, Object> secrets) {
    Map<String, Object> resolved = Needs.resolveEnv(tool.id(), tool.extra().get("needsSpec"), env);
    return new ToolContext("t-test", "run-test", null, null, null, resolved,
        secrets != null ? secrets : Map.of(), Map.of(), Map.of(), new Cancellation(), Logger.noop());
  }

  /**
   * Builds a {@link ToolContext} for a unit test, overriding only what a test cares about; pass it
   * to {@link #forTest(Builder)}.
   */
  public static final class Builder {
    private String tenantId = "t-test";
    private String runId = "run-test";
    private @Nullable String requestId;
    private @Nullable String projectId;
    private @Nullable String orgId;
    private Map<String, Object> env = Map.of();
    private Map<String, Object> secrets = Map.of();
    private Map<String, Object> config = Map.of();
    private Map<String, Map<String, Object>> settings = Map.of();
    private Cancellation cancellation = new Cancellation();
    private Logger log = Logger.noop();
    private @Nullable String idempotencyKey;

    /**
     * @param tenantId the tenant the call runs for
     * @return this
     */
    public Builder withTenantId(String tenantId) {
      this.tenantId = tenantId;
      return this;
    }

    /**
     * @param runId the run the call belongs to
     * @return this
     */
    public Builder withRunId(String runId) {
      this.runId = runId;
      return this;
    }

    /**
     * @param requestId the individual call's id
     * @return this
     */
    public Builder withRequestId(String requestId) {
      this.requestId = requestId;
      return this;
    }

    /**
     * @param projectId the run's project
     * @return this
     */
    public Builder withProjectId(String projectId) {
      this.projectId = projectId;
      return this;
    }

    /**
     * @param orgId the project's org
     * @return this
     */
    public Builder withOrgId(String orgId) {
      this.orgId = orgId;
      return this;
    }

    /**
     * @param env resolved environment values for the call, by name
     * @return this
     */
    public Builder withEnv(Map<String, String> env) {
      this.env = new LinkedHashMap<>(env);
      return this;
    }

    /**
     * @param secrets resolved secrets for the call, by name
     * @return this
     */
    public Builder withSecrets(Map<String, Object> secrets) {
      this.secrets = new LinkedHashMap<>(secrets);
      return this;
    }

    /**
     * @param config resolved configuration for the call
     * @return this
     */
    public Builder withConfig(Map<String, Object> config) {
      this.config = new LinkedHashMap<>(config);
      return this;
    }

    /**
     * @param settings the settings blocks the calling agent version pins, by block id
     * @return this
     */
    public Builder withSettings(Map<String, Map<String, Object>> settings) {
      this.settings = new LinkedHashMap<>(settings);
      return this;
    }

    /**
     * @param log the logger the handler's {@link ToolContext#log()} writes to
     * @return this
     */
    public Builder withLog(Logger log) {
      this.log = log;
      return this;
    }

    /**
     * @param idempotencyKey a key for the call's side effects
     * @return this
     */
    public Builder withIdempotencyKey(String idempotencyKey) {
      this.idempotencyKey = idempotencyKey;
      return this;
    }
  }

  /** @return the secrets, without their values (a context may be logged) */
  @Override
  public String toString() {
    return "ToolContext[tenantId=" + tenantId + ", runId=" + runId + ", requestId=" + requestId + ", secrets=" + secrets.keySet() + "]";
  }

  /** Secrets: a map like any other, except that printing it never shows a value. */
  private static final class Hidden extends AbstractMap<String, Object> {
    private final Map<String, Object> values;

    Hidden(Map<String, Object> values) {
      this.values = Collections.unmodifiableMap(new LinkedHashMap<>(values));
    }

    @Override
    public Set<Map.Entry<String, Object>> entrySet() {
      return values.entrySet();
    }

    @Override
    public Object get(Object key) {
      return values.get(key);
    }

    @Override
    public boolean containsKey(Object key) {
      return values.containsKey(key);
    }

    @Override
    public String toString() {
      StringBuilder out = new StringBuilder("{");
      for (String name : values.keySet()) {
        out.append(out.length() == 1 ? "" : ", ").append(name).append("=<hidden>");
      }
      return out.append('}').toString();
    }
  }
}
