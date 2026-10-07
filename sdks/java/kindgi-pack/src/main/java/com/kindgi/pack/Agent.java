// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * An agent, as data: its instructions, the tools it may call, the guardrails on its answers.
 * Define it as a {@code public static final} field of a class under the pack's agents.
 *
 * <pre>{@code
 * public static final Agent AGENT = Agent.define("acme.bookkeeper")
 *     .version("1.0.0")
 *     .name("Bookkeeper")
 *     .instructions("Classify the document, then call acme.record-expense.")
 *     .capability(Map.of("needs", List.of(Map.of("feature", "tool-use"))))
 *     .tool(RecordExpense.TOOL)
 *     .guardrail(ResponseNotEmpty.GUARDRAIL)
 *     .build();
 * }</pre>
 */
public final class Agent {
  private final String id;
  private final Map<String, Object> entry;
  private final List<Object> tools;

  private final Class<?> definedIn;

  private Agent(Class<?> definedIn, String id, Map<String, Object> entry, List<Object> tools) {
    this.definedIn = definedIn;
    this.id = id;
    this.entry = Map.copyOf(entry);
    this.tools = List.copyOf(tools);
  }

  /**
   * @param id the agent's id, prefixed with the pack's id
   * @return a builder
   */
  public static Builder define(String id) {
    return new Builder(id, StackWalker.getInstance(StackWalker.Option.RETAIN_CLASS_REFERENCE).getCallerClass());
  }

  /** @return the agent's id */
  public String id() {
    return id;
  }

  Map<String, Object> entry() {
    return entry;
  }

  Class<?> definedIn() {
    return definedIn;
  }

  /** The tools, each a {@link Tool} or an {@code {id, version}} map. */
  List<Object> tools() {
    return tools;
  }

  @Override
  public String toString() {
    return "Agent[" + id + "]";
  }

  /** Builds an {@link Agent}. */
  public static final class Builder {
    private final String id;
    private final Map<String, Object> entry = new LinkedHashMap<>();
    private final List<Object> capabilities = new ArrayList<>();
    private final List<Object> tools = new ArrayList<>();
    private final List<Object> guardrails = new ArrayList<>();

    private final Class<?> definedIn;

    private Builder(String id, Class<?> definedIn) {
      if (id == null || id.isBlank()) {
        throw new IllegalArgumentException("an agent needs an id");
      }
      this.id = id;
      this.definedIn = definedIn;
    }

    /**
     * @param version the agent's version
     * @return this
     */
    public Builder version(String version) {
      entry.put("version", version);
      return this;
    }

    /**
     * @param name a name to show
     * @return this
     */
    public Builder name(String name) {
      entry.put("name", name);
      return this;
    }

    /**
     * @param instructions the agent's instructions
     * @return this
     */
    public Builder instructions(String instructions) {
      entry.put("instructions", instructions);
      return this;
    }

    /**
     * @param instructions a prompt block reference ({@code {prompt, version}})
     * @return this
     */
    public Builder instructions(Map<String, Object> instructions) {
      entry.put("instructions", Map.copyOf(instructions));
      return this;
    }

    /**
     * @param capability what the agent's model must support ({@code {needs: [{feature: tool-use}]}})
     * @return this
     */
    public Builder capability(Map<String, Object> capability) {
      capabilities.add(capability);
      return this;
    }

    /**
     * @param tool a tool the agent may call, at its version
     * @return this
     */
    public Builder tool(Tool<?, ?> tool) {
      tools.add(tool);
      return this;
    }

    /**
     * @param id a tool of another pack
     * @param version its version
     * @return this
     */
    public Builder tool(String id, String version) {
      Map<String, Object> ref = new LinkedHashMap<>();
      ref.put("id", id);
      ref.put("version", version);
      tools.add(ref);
      return this;
    }

    /**
     * @param guardrail a guardrail on the agent's answers
     * @return this
     */
    public Builder guardrail(Guardrail<?> guardrail) {
      guardrails.add(guardrail.id());
      return this;
    }

    /**
     * @param id a guardrail, by id
     * @return this
     */
    public Builder guardrail(String id) {
      guardrails.add(id);
      return this;
    }

    /**
     * Another field of the agent's index entry, as the pack index schema names it ({@code
     * retrieval}, {@code parameters}, {@code budget}, {@code preferredModel}, {@code output}, …).
     *
     * @param field the field
     * @param value its value
     * @return this
     */
    public Builder set(String field, Object value) {
      entry.put(field, value);
      return this;
    }

    /**
     * @param type the type of the agent's structured answer; its schema is derived
     * @return this
     */
    public Builder output(Class<?> type) {
      entry.put("output", Map.of("schema", com.kindgi.pack.internal.SchemaDeriver.schema(type)));
      return this;
    }

    /** @return the agent
     * @throws IllegalStateException when its version, name or instructions are missing */
    public Agent build() {
      for (String field : List.of("version", "name", "instructions")) {
        if (!entry.containsKey(field)) {
          throw new IllegalStateException("agent " + id + ": " + field + " is required");
        }
      }
      Map<String, Object> e = new LinkedHashMap<>(entry);
      e.put("id", id);
      e.put("capabilities", List.copyOf(capabilities));
      e.put("guardrails", List.copyOf(guardrails));
      e.putIfAbsent("retrieval", List.of());
      e.putIfAbsent("parameters", List.of());
      e.putIfAbsent("settings", List.of());
      return new Agent(definedIn, id, e, tools);
    }
  }
}
