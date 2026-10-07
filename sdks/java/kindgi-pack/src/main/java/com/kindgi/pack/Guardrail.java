// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import com.kindgi.pack.internal.SchemaDeriver;
import java.lang.reflect.Type;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * A guardrail: a check on a run's answers, and what to do when it fails. Define it as a {@code
 * public static final} field of a class under the pack's guardrails.
 *
 * <pre>{@code
 * public static final Guardrail<MinLength> RESPONSE_NOT_EMPTY = Guardrail.define("acme.response-not-empty")
 *     .checkId("acme.checks.response-not-empty")
 *     .onViolation("halt")
 *     .severity("error")
 *     .config(MinLength.class)
 *     .check((config, trace) -> (trace.output() == null ? "" : trace.output().strip()).length() >= config.minLength()
 *         ? CheckResult.pass() : CheckResult.fail("too short"));
 * }</pre>
 *
 * @param <C> the config type
 */
public final class Guardrail<C> {
  private final String id;
  private final @Nullable String checkId;
  private final Map<String, Object> entry;
  private final Type configType;
  private final @Nullable Map<String, Object> configSchema;
  private final CheckHandler<C> check;
  private final Class<?> definedIn;

  private Guardrail(Builder<C> b, CheckHandler<C> check) {
    this.id = b.id;
    this.checkId = b.checkId;
    this.entry = Map.copyOf(b.entry);
    this.configType = b.configType;
    this.configSchema = b.configSchema;
    this.check = Objects.requireNonNull(check, "check");
    this.definedIn = b.definedIn;
  }

  /**
   * @param id the guardrail's id, prefixed with the pack's id
   * @return a builder (its config is any JSON object until {@code config} says otherwise)
   */
  public static Builder<Map<String, Object>> define(String id) {
    return new Builder<>(id, StackWalker.getInstance(StackWalker.Option.RETAIN_CLASS_REFERENCE).getCallerClass());
  }

  /** @return the guardrail's id */
  public String id() {
    return id;
  }

  /** @return the check's id; {@code null} uses the guardrail's */
  public @Nullable String checkId() {
    return checkId;
  }

  Map<String, Object> entry() {
    return entry;
  }

  Type configType() {
    return configType;
  }

  CheckHandler<C> handler() {
    return check;
  }

  Class<?> definedIn() {
    return definedIn;
  }

  /**
   * @return the config's JSON Schema; {@code null} when the config is any object
   */
  public @Nullable Map<String, Object> configSchema() {
    if (configSchema != null) {
      return configSchema;
    }
    return configType == Map.class ? null : SchemaDeriver.schema(configType);
  }

  @Override
  public String toString() {
    return "Guardrail[" + id + "]";
  }

  /**
   * Builds a {@link Guardrail}.
   *
   * @param <C> the config type
   */
  public static final class Builder<C> {
    private final String id;
    private @Nullable String checkId;
    private final Map<String, Object> entry = new LinkedHashMap<>();
    private Type configType = Map.class;
    private @Nullable Map<String, Object> configSchema;
    private final Class<?> definedIn;

    private Builder(String id, Class<?> definedIn) {
      if (id == null || id.isBlank()) {
        throw new IllegalArgumentException("a guardrail needs an id");
      }
      this.id = id;
      this.definedIn = definedIn;
      entry.put("kind", "zero-llm");
    }

    @SuppressWarnings("unchecked")
    private <D> Builder<D> cast() {
      return (Builder<D>) this;
    }

    /**
     * @param name a name to show
     * @return this
     */
    public Builder<C> name(String name) {
      entry.put("name", name);
      return this;
    }

    /**
     * @param checkId the check's id, when it differs from the guardrail's
     * @return this
     */
    public Builder<C> checkId(String checkId) {
      this.checkId = checkId;
      return this;
    }

    /**
     * @param kind the check's kind (default {@code zero-llm})
     * @return this
     */
    public Builder<C> kind(String kind) {
      entry.put("kind", kind);
      return this;
    }

    /**
     * @param action what a failing check does: {@code halt}, {@code retry}, {@code escalate},
     *     {@code log-only}, …
     * @return this
     */
    public Builder<C> onViolation(String action) {
      Map<String, Object> a = new LinkedHashMap<>();
      a.put("on-violation", action);
      entry.put("action", a);
      return this;
    }

    /**
     * @param action the whole action object ({@code {"on-violation": "retry", "retry": {…}}})
     * @return this
     */
    public Builder<C> action(Map<String, Object> action) {
      entry.put("action", Map.copyOf(action));
      return this;
    }

    /**
     * @param severity {@code error}, {@code warning}, …
     * @return this
     */
    public Builder<C> severity(String severity) {
      entry.put("severity", severity);
      return this;
    }

    /**
     * @param <D> the config type
     * @param type the config type; its schema is derived
     * @return this
     */
    public <D> Builder<D> config(Class<D> type) {
      this.configType = type;
      this.configSchema = null;
      return cast();
    }

    /**
     * @param schema the config's JSON Schema; the config is a {@code Map}
     * @return this
     */
    public Builder<Map<String, Object>> configSchema(Map<String, Object> schema) {
      this.configType = Map.class;
      this.configSchema = Map.copyOf(schema);
      return cast();
    }

    /**
     * Another field of the guardrail's index entry ({@code scope}, {@code config}, {@code sandbox},
     * {@code limits}, {@code network}).
     *
     * @param field the field
     * @param value its value
     * @return this
     */
    public Builder<C> set(String field, Object value) {
      entry.put(field, value);
      return this;
    }

    /**
     * @param check the check, answering later; the service awaits it
     * @return the guardrail
     */
    public Guardrail<C> asyncCheck(AsyncCheckHandler<C> check) {
      Objects.requireNonNull(check, "check");
      return check((config, trace) -> Awaiting.await(check.check(config, trace), null));
    }

    /**
     * @param check the check
     * @return the guardrail
     */
    public Guardrail<C> check(CheckHandler<C> check) {
      if (!entry.containsKey("action")) {
        throw new IllegalStateException("guardrail " + id + ": say what a failing check does (onViolation or action)");
      }
      return new Guardrail<>(this, check);
    }
  }
}
