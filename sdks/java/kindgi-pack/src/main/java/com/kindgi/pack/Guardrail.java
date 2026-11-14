// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import com.kindgi.pack.internal.SchemaDeriver;
import java.lang.reflect.Type;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;
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
 * A guardrail always ships its check, so its check id can't be one of the built-in checks' ({@link
 * #RESERVED_CHECK_IDS}): the runtime runs the built-in for a guardrail naming one, and would
 * silently replace the pack's. To use a built-in, name it with {@link Builder#builtInCheck(String,
 * Map)} in place of a check:
 *
 * <pre>{@code
 * public static final Guardrail<Map<String, Object>> NO_GUARANTEES = Guardrail.define("acme.no-guarantees")
 *     .onViolation("halt")
 *     .builtInCheck("forbidden-substring", Map.of("patterns", List.of("guaranteed", "we promise")));
 * }</pre>
 *
 * @param <C> the config type
 */
public final class Guardrail<C> {
  /**
   * The built-in checks' ids ({@code BUILT_IN_CHECK_IDS} in the TypeScript {@code
   * @kindgi/guardrails}; a test holds the two equal). The runtime runs the built-in for a guardrail
   * naming one, so a pack can't ship its own check under one: {@link Builder#check} refuses it,
   * and {@link Builder#builtInCheck(String)} names one.
   */
  public static final List<String> RESERVED_CHECK_IDS = List.of(
      "must-cite",
      "never-call-tool",
      "max-tool-calls",
      "output-matches",
      "tool-order",
      "required-substring",
      "forbidden-substring");

  /**
   * Where in a turn a guardrail may run ({@code GUARDRAIL_POINTS} in the TypeScript {@code
   * @kindgi/guardrails}), held to the pack-index schema's {@code at} by GuardrailTest.
   */
  static final List<String> GUARDRAIL_POINTS =
      List.of("before-tool", "after-tool", "model-step", "final-answer");

  /** A {@code scope.tools} entry: a tool id, or a prefix with a trailing {@code *} ({@code SCOPE_TOOL} in TypeScript). */
  private static final Pattern SCOPE_TOOL = Pattern.compile("^[^*]*\\*?$");

  private final String id;
  private final @Nullable String checkId;
  private final Map<String, Object> entry;
  private final Type configType;
  private final @Nullable Map<String, Object> configSchema;
  private final CheckHandler<C> check;
  private final Class<?> definedIn;
  private final boolean builtIn;

  private Guardrail(Builder<C> b, CheckHandler<C> check) {
    this(b, b.checkId, b.entry, false, check);
  }

  private Guardrail(
      Builder<C> b, @Nullable String checkId, Map<String, Object> entry, boolean builtIn, CheckHandler<C> check) {
    this.id = b.id;
    this.checkId = checkId;
    this.entry = Map.copyOf(entry);
    this.configType = b.configType;
    this.configSchema = b.configSchema;
    this.check = Objects.requireNonNull(check, "check");
    this.definedIn = b.definedIn;
    this.builtIn = builtIn;
  }

  /**
   * @param id the guardrail's id, prefixed with the pack's id
   * @return a builder (its config is any JSON object until {@code config} says otherwise)
   */
  public static Builder<Map<String, Object>> define(String id) {
    return new Builder<>(id, Callers.definer());
  }

  /** @return the guardrail's id */
  public String id() {
    return id;
  }

  /** @return the check's id; {@code null} uses the guardrail's */
  public @Nullable String checkId() {
    return checkId;
  }

  /**
   * @return whether its check is a built-in, which the runtime runs ({@link
   *     Builder#builtInCheck(String)})
   */
  public boolean builtIn() {
    return builtIn;
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
   * Runs the check, for a unit test: with the config as given (no schema check, no defaults filled
   * in) and the run. A check given with {@code asyncCheck} is awaited. A built-in's throws: only the
   * runtime runs it.
   *
   * <pre>{@code
   * CheckResult result = Checks.RESPONSE_NOT_EMPTY.evaluate(new MinLength(1), new RunTrace(Map.of("output", "")));
   * assertFalse(result.passed());
   * }</pre>
   *
   * @param config the config
   * @param trace the run ({@code new RunTrace(Map.of("output", …, "toolCalls", List.of(…)))})
   * @return the verdict
   * @throws Exception what the check throws
   * @throws UnsupportedOperationException when the check is a built-in
   */
  public CheckResult evaluate(C config, RunTrace trace) throws Exception {
    return check.check(config, trace);
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
     * What an {@code llm-judge} guardrail's judge model is routed by, as a capability
     * declaration ({@code Map.of("needs", List.of(Map.of("feature", "structured-output")))}). The
     * runtime judges with the model it routes to, and the guardrail's {@code config} (its rubric);
     * an {@code llm-judge} guardrail needs it.
     *
     * @param capabilities the judge's capability declaration
     * @return this
     */
    public Builder<C> judgeCapabilities(Map<String, Object> capabilities) {
      entry.put("judgeCapabilities", Map.copyOf(capabilities));
      return this;
    }

    /**
     * The runtime acts on {@code halt}: the turn fails with {@code guardrail-violation}. It acts
     * on {@code retry} too: the answer goes back to the model with the check's reason, for a new
     * one, until the guardrail has failed two answers ({@link #action(Map)} with {@code "retry":
     * {"maxAttempts": n}} sets another count), and then the turn fails the same way. Any other action is recorded on the
     * turn's violations and the turn completes; in 0.1 nothing escalates or calls a compensating
     * tool.
     *
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
     * @throws IllegalStateException when nothing says what a failing check does, the check's id
     *     ({@code checkId}, else the guardrail's) is a built-in check's ({@link Guardrail#RESERVED_CHECK_IDS}),
     *     or an {@code llm-judge} guardrail names no {@link #judgeCapabilities(Map)}
     */
    public Guardrail<C> check(CheckHandler<C> check) {
      if (!entry.containsKey("action")) {
        throw new IllegalStateException("guardrail " + id + ": say what a failing check does (onViolation or action)");
      }
      if ("llm-judge".equals(entry.get("kind")) && !entry.containsKey("judgeCapabilities")) {
        throw new IllegalStateException("guardrail " + id + " is kind llm-judge with no judgeCapabilities: name what"
            + " its judge model is routed by (judgeCapabilities(Map.of(\"needs\", List.of(Map.of(\"feature\","
            + " \"structured-output\")))))");
      }
      String resolved = checkId != null ? checkId : id;
      if (RESERVED_CHECK_IDS.contains(resolved)) {
        throw new IllegalStateException("guardrail " + id + ": its check id \"" + resolved + "\" is a built-in check's, and"
            + " a pack can't replace a built-in. Rename your check (checkId(\"<pack>.checks." + resolved + "\"))"
            + (checkId != null ? "" : ", or rename the guardrail") + ".");
      }
      return new Guardrail<>(this, check);
    }

    /**
     * Names a built-in check with its defaults, in place of a {@link #check}: the Kindgi runtime
     * runs it. See {@link #builtInCheck(String, Map)}.
     *
     * @param checkId the built-in's id, one of {@link Guardrail#RESERVED_CHECK_IDS}
     * @return the guardrail
     * @throws IllegalArgumentException when {@code checkId} isn't a built-in's
     * @throws IllegalStateException as {@link #builtInCheck(String, Map)} says
     */
    public Guardrail<Map<String, Object>> builtInCheck(String checkId) {
      return builtIn(checkId, null);
    }

    /**
     * Names a built-in check in place of a {@link #check}: the Kindgi runtime runs it, with {@code
     * config} as its settings, keyed as on the wire ({@code Map.of("patterns",
     * List.of("guaranteed"))}). It runs where {@code set("at", …)} says: {@code before-tool},
     * {@code after-tool}, {@code model-step} or {@code final-answer} (left out, the final answer).
     * The runtime checks the settings, and that the built-in runs at that point, when the pack is
     * registered and deployed. Calling {@link Guardrail#evaluate} throws: only the runtime runs it.
     *
     * @param checkId the built-in's id, one of {@link Guardrail#RESERVED_CHECK_IDS}
     * @param config the built-in's settings
     * @return the guardrail
     * @throws IllegalArgumentException when {@code checkId} isn't a built-in's
     * @throws IllegalStateException when nothing says what a failing check does; when the guardrail
     *     can't act there ({@code escalate} or {@code compensate} away from the final answer, {@code
     *     scope.tools} away from {@code before-tool} and {@code after-tool}); or when the builder
     *     holds what a built-in doesn't take: a {@code set("config", …)} as well, a typed config or
     *     config schema, a {@code checkId}, a {@code kind} other than {@code zero-llm}, {@code
     *     judgeCapabilities}, or a {@code sandbox}, {@code limits} or {@code network}
     */
    public Guardrail<Map<String, Object>> builtInCheck(String checkId, Map<String, ?> config) {
      Objects.requireNonNull(config, "config");
      return builtIn(checkId, config);
    }

    private Guardrail<Map<String, Object>> builtIn(String builtIn, @Nullable Map<String, ?> config) {
      Objects.requireNonNull(builtIn, "checkId");
      if (!RESERVED_CHECK_IDS.contains(builtIn)) {
        throw new IllegalArgumentException("guardrail " + id + ": \"" + builtIn + "\" isn't a built-in check. The"
            + " built-ins are " + String.join(", ", RESERVED_CHECK_IDS) + "; a check of your own is check(…).");
      }
      if (!entry.containsKey("action")) {
        throw new IllegalStateException("guardrail " + id + ": say what a failing check does (onViolation or action)");
      }
      if (config != null && entry.containsKey("config")) {
        throw new IllegalStateException("guardrail " + id + ": its config is given twice, by set(\"config\", …) and"
            + " by builtInCheck(…, config). Give it once.");
      }
      if (configType != Map.class || configSchema != null || entry.containsKey("configSchema")) {
        throw new IllegalStateException("guardrail " + id + ": a built-in's config is the runtime's to check, so it"
            + " takes no typed config or config schema");
      }
      if (checkId != null || entry.containsKey("checkId")) {
        throw new IllegalStateException("guardrail " + id + ": builtInCheck names its check, so it takes no"
            + " checkId(…)");
      }
      if (!"zero-llm".equals(entry.get("kind"))) {
        throw new IllegalStateException("guardrail " + id + ": a built-in check is zero-llm, not " + entry.get("kind"));
      }
      List<String> unused = new ArrayList<>();
      for (String field : List.of("judgeCapabilities", "sandbox", "limits", "network")) {
        if (entry.containsKey(field)) {
          unused.add(field);
        }
      }
      if (!unused.isEmpty()) {
        throw new IllegalStateException("guardrail " + id + ": the runtime runs a built-in check, which takes no "
            + String.join(", ", unused));
      }
      // TypeScript's indexer refuses the same, at build (`guardrailPointIssues`).
      Object atValue = entry.get("at");
      String at = atValue == null ? "final-answer" : String.valueOf(atValue);
      if (!GUARDRAIL_POINTS.contains(at)) {
        throw new IllegalStateException("guardrail " + id + ": at must be one of " + String.join(", ", GUARDRAIL_POINTS));
      }
      if (entry.get("scope") instanceof Map<?, ?> scoped && scoped.containsKey("tools")
          && !(scoped.get("tools") instanceof List<?> tools && !tools.isEmpty() && tools.stream()
              .allMatch(t -> t instanceof String s && !s.isEmpty() && SCOPE_TOOL.matcher(s).matches()))) {
        throw new IllegalStateException("guardrail " + id + ": scope.tools must name one or more tool ids, each with at"
            + " most a trailing '*'");
      }
      Object violation = entry.get("action") instanceof Map<?, ?> action ? action.get("on-violation") : null;
      if (("escalate".equals(violation) || "compensate".equals(violation)) && !"final-answer".equals(at)) {
        throw new IllegalStateException("guardrail " + id + ": \"" + violation + "\" is recorded at the final answer"
            + " only, not at \"" + at + "\"");
      }
      if (entry.get("scope") instanceof Map<?, ?> scope && scope.containsKey("tools")
          && !"before-tool".equals(at) && !"after-tool".equals(at)) {
        throw new IllegalStateException("guardrail " + id + ": scope.tools is for \"before-tool\" and \"after-tool\","
            + " not \"" + at + "\"");
      }
      // A terminal, not a setter: the config goes on this guardrail only, as an HTTP tool's spec does.
      Map<String, Object> builtInEntry = new LinkedHashMap<>(entry);
      builtInEntry.put("checkBuiltIn", true);
      if (config != null) {
        builtInEntry.put("config", Map.copyOf(config));
      }
      Builder<Map<String, Object>> self = cast();
      // The runtime runs a built-in, so its local handler reads no config and must throw the same error whatever
      // config type it's called with (the Scala DSL passes Scala maps): typed on Object, no bridge cast runs.
      CheckHandler<Object> runtimeOnly = (c, trace) -> {
        throw new UnsupportedOperationException("guardrail " + id + " names the built-in check \"" + builtIn
            + "\": the Kindgi runtime runs it, not the Java SDK. Run it through Kindgi (an agent, a flow, `kindgi dev`).");
      };
      @SuppressWarnings("unchecked")
      CheckHandler<Map<String, Object>> handler = (CheckHandler<Map<String, Object>>) (CheckHandler<?>) runtimeOnly;
      return new Guardrail<>(self, builtIn, builtInEntry, true, handler);
    }
  }
}
