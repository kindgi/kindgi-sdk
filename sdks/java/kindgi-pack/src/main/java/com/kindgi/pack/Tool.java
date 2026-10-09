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
import org.jspecify.annotations.Nullable;

/**
 * A tool: typed code the runtime calls for an agent or a flow. Define it as a {@code public
 * static final} field of a class under the pack's tools; the indexer finds it there.
 *
 * <pre>{@code
 * public final class Greet {
 *   public record Input(@Size(min = 1, max = 100) String name) {}
 *   public record Output(String message) {}
 *
 *   public static final Tool<Input, Output> TOOL = Tool.define("acme.greet")
 *       .description("Formats a greeting for the named recipient.")
 *       .input(Input.class)
 *       .output(Output.class)
 *       .mutating(false)
 *       .handler((input, ctx) -> new Output("Hello, " + input.name() + "!"));
 * }
 * }</pre>
 *
 * The input and output schemas come from the types (see {@code SchemaDeriver}), or are given as
 * JSON Schema; the service checks both on every call.
 *
 * @param <I> the input type
 * @param <O> the output type
 */
public final class Tool<I, O> {
  private static final Map<String, Object> ANY_OBJECT = Map.of("type", "object");

  private final String id;
  private final @Nullable String description;
  private final @Nullable String version;
  private final Type inputType;
  private final @Nullable Map<String, Object> inputSchema;
  private final Type outputType;
  private final @Nullable Map<String, Object> outputSchema;
  private final @Nullable Boolean mutating;
  private final List<Map<String, Object>> effects;
  private final Map<String, Object> extra;
  private final ToolHandler<I, O> handler;
  private final Class<?> definedIn;

  private Tool(Builder<I, O> b, ToolHandler<I, O> handler) {
    this.id = b.id;
    this.description = b.description;
    this.version = b.version;
    this.inputType = b.inputType;
    this.inputSchema = b.inputSchema;
    this.outputType = b.outputType;
    this.outputSchema = b.outputSchema;
    this.mutating = b.mutating;
    this.effects = List.copyOf(b.effects);
    this.extra = Map.copyOf(b.extra);
    this.handler = Objects.requireNonNull(handler, "handler");
    this.definedIn = b.definedIn;
  }

  /**
   * Starts a tool: its input and output are any JSON objects ({@code Map}s) until {@code input}
   * and {@code output} say otherwise.
   *
   * @param id the tool's id, prefixed with the pack's id ({@code acme.greet})
   * @return a builder
   */
  public static Builder<Map<String, Object>, Map<String, Object>> define(String id) {
    return new Builder<>(id, StackWalker.getInstance(StackWalker.Option.RETAIN_CLASS_REFERENCE).getCallerClass());
  }

  /** @return the tool's id */
  public String id() {
    return id;
  }

  /** @return the tool's own version; {@code null} takes the pack's */
  public @Nullable String version() {
    return version;
  }

  /** @return what the tool does, for the model */
  public @Nullable String description() {
    return description;
  }

  /** @return whether the tool changes something; {@code null} when it doesn't say (it may) */
  public @Nullable Boolean mutating() {
    return mutating;
  }

  List<Map<String, Object>> effects() {
    return effects;
  }

  Map<String, Object> extra() {
    return extra;
  }

  Type inputType() {
    return inputType;
  }

  Type outputType() {
    return outputType;
  }

  ToolHandler<I, O> handler() {
    return handler;
  }

  /** The class whose code defined the tool: the indexer takes a tool from that class only. */
  Class<?> definedIn() {
    return definedIn;
  }

  /**
   * @return the input's JSON Schema
   * @throws SchemaDeriver.DerivationException when the input type can't be expressed
   */
  public Map<String, Object> inputSchema() {
    return inputSchema != null ? inputSchema : SchemaDeriver.schema(inputType);
  }

  /**
   * @return the output's JSON Schema
   * @throws SchemaDeriver.DerivationException when the output type can't be expressed
   */
  public Map<String, Object> outputSchema() {
    return outputSchema != null ? outputSchema : SchemaDeriver.schema(outputType);
  }

  /**
   * Calls the handler directly, for a unit test.
   *
   * @param input the input
   * @param ctx the context ({@link ToolContext#forTest()})
   * @return the output
   * @throws Exception what the handler throws
   */
  public O call(I input, ToolContext ctx) throws Exception {
    return handler.handle(input, ctx);
  }

  @Override
  public String toString() {
    return "Tool[" + id + "]";
  }

  /**
   * Builds a {@link Tool}.
   *
   * @param <I> the input type
   * @param <O> the output type
   */
  public static final class Builder<I, O> {
    private final String id;
    private @Nullable String description;
    private @Nullable String version;
    private Type inputType = Map.class;
    private @Nullable Map<String, Object> inputSchema = ANY_OBJECT;
    private Type outputType = Map.class;
    private @Nullable Map<String, Object> outputSchema = ANY_OBJECT;
    private @Nullable Boolean mutating;
    private final List<Map<String, Object>> effects = new ArrayList<>();
    private final Map<String, Object> extra = new LinkedHashMap<>();
    private final Class<?> definedIn;

    private Builder(String id, Class<?> definedIn) {
      if (id == null || id.isBlank()) {
        throw new IllegalArgumentException("a tool needs an id");
      }
      this.id = id;
      this.definedIn = definedIn;
    }

    @SuppressWarnings("unchecked")
    private <J, P> Builder<J, P> cast() {
      return (Builder<J, P>) this;
    }

    /**
     * @param description what the tool does, for the model
     * @return this
     */
    public Builder<I, O> description(String description) {
      this.description = description;
      return this;
    }

    /**
     * @param version the tool's own version (default: the pack's)
     * @return this
     */
    public Builder<I, O> version(String version) {
      this.version = version;
      return this;
    }

    /**
     * @param <J> the input type
     * @param type the input type: a record, usually; its schema is derived
     * @return this
     */
    public <J> Builder<J, O> input(Class<J> type) {
      this.inputType = type;
      this.inputSchema = null;
      return cast();
    }

    /**
     * @param schema the input's JSON Schema, as given; the input is a {@code Map}
     * @return this
     */
    public Builder<Map<String, Object>, O> input(Map<String, Object> schema) {
      this.inputType = Map.class;
      this.inputSchema = Map.copyOf(schema);
      return cast();
    }

    /**
     * @param <P> the output type
     * @param type the output type; its schema is derived
     * @return this
     */
    public <P> Builder<I, P> output(Class<P> type) {
      this.outputType = type;
      this.outputSchema = null;
      return cast();
    }

    /**
     * @param schema the output's JSON Schema, as given; the handler returns any JSON value
     * @return this
     */
    public Builder<I, Object> output(Map<String, Object> schema) {
      this.outputType = Object.class;
      this.outputSchema = Map.copyOf(schema);
      return cast();
    }

    /**
     * @param mutating whether the tool changes anything: {@code false} lets a dry run call it and
     *     approval gates skip it; leave it unset for a tool that writes, sends or charges
     * @return this
     */
    public Builder<I, O> mutating(boolean mutating) {
      this.mutating = mutating;
      return this;
    }

    /**
     * @param kind what the tool does outside its code ({@code writes}, {@code network}, …)
     * @param resource to what ({@code db:ledger})
     * @return this
     */
    public Builder<I, O> effect(String kind, String resource) {
      Map<String, Object> e = new LinkedHashMap<>();
      e.put("kind", kind);
      e.put("resource", resource);
      effects.add(e);
      return this;
    }

    /**
     * Another field of the tool's index entry, as the pack index schema names it ({@code needs},
     * {@code needsSpec}, {@code sandbox}, {@code limits}, {@code network}).
     *
     * @param field the field
     * @param value its value
     * @return this
     */
    public Builder<I, O> set(String field, Object value) {
      extra.put(field, value);
      return this;
    }

    /**
     * @param handler the tool's code
     * @return the tool
     */
    public Tool<I, O> handler(ToolHandler<I, O> handler) {
      return new Tool<>(this, handler);
    }
  }
}
