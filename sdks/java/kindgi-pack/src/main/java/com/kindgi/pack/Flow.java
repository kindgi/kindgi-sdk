// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A flow, as data: its nodes and the edges between them. Define it as a {@code public static
 * final} field of a class under the pack's flows.
 *
 * <pre>{@code
 * public static final Flow FLOW = Flow.define("acme.record-flow")
 *     .version("1.0.0")
 *     .toolNode("record", RecordExpense.TOOL)
 *     .edge("e-start", "$start", "record")
 *     .edge("e-end", "record", "$end")
 *     .build();
 * }</pre>
 */
public final class Flow {
  private final String id;
  private final Map<String, Object> entry;

  private final Class<?> definedIn;

  private Flow(Class<?> definedIn, String id, Map<String, Object> entry) {
    this.definedIn = definedIn;
    this.id = id;
    this.entry = Map.copyOf(entry);
  }

  /**
   * @param id the flow's id, prefixed with the pack's id
   * @return a builder
   */
  public static Builder define(String id) {
    return new Builder(id, StackWalker.getInstance(StackWalker.Option.RETAIN_CLASS_REFERENCE).getCallerClass());
  }

  /** @return the flow's id */
  public String id() {
    return id;
  }

  Map<String, Object> entry() {
    return entry;
  }

  Class<?> definedIn() {
    return definedIn;
  }

  @Override
  public String toString() {
    return "Flow[" + id + "]";
  }

  /** A node as data: a {@link Tool}, {@link Agent} or {@link Flow} becomes its id, in loop bodies and fanout branches too. */
  @SuppressWarnings("unchecked")
  static Object refIds(Object value) {
    if (value instanceof Tool) {
      return ((Tool<?, ?>) value).id();
    }
    if (value instanceof Agent) {
      return ((Agent) value).id();
    }
    if (value instanceof Flow) {
      return ((Flow) value).id();
    }
    if (value instanceof Map) {
      Map<String, Object> out = new LinkedHashMap<>();
      ((Map<String, Object>) value).forEach((k, v) -> out.put(k, refIds(v)));
      return out;
    }
    if (value instanceof List) {
      List<Object> out = new ArrayList<>();
      for (Object v : (List<Object>) value) {
        out.add(refIds(v));
      }
      return out;
    }
    return value;
  }

  /** Builds a {@link Flow}. */
  public static final class Builder {
    private final String id;
    private final Map<String, Object> entry = new LinkedHashMap<>();
    private final List<Object> nodes = new ArrayList<>();
    private final List<Object> edges = new ArrayList<>();

    private final Class<?> definedIn;

    private Builder(String id, Class<?> definedIn) {
      if (id == null || id.isBlank()) {
        throw new IllegalArgumentException("a flow needs an id");
      }
      this.id = id;
      this.definedIn = definedIn;
    }

    /**
     * @param version the flow's version
     * @return this
     */
    public Builder version(String version) {
      entry.put("version", version);
      return this;
    }

    /**
     * @param nodeId the node's id
     * @param tool the tool it runs
     * @return this
     */
    public Builder toolNode(String nodeId, Tool<?, ?> tool) {
      Map<String, Object> node = new LinkedHashMap<>();
      node.put("id", nodeId);
      node.put("kind", "tool");
      node.put("ref", tool.id());
      nodes.add(node);
      return this;
    }

    /**
     * @param nodeId the node's id
     * @param agent the agent it runs
     * @return this
     */
    public Builder agentNode(String nodeId, Agent agent) {
      Map<String, Object> node = new LinkedHashMap<>();
      node.put("id", nodeId);
      node.put("kind", "agent");
      node.put("ref", agent.id());
      nodes.add(node);
      return this;
    }

    /**
     * @param node any node, as the flow schema describes it
     * @return this
     */
    public Builder node(Map<String, Object> node) {
      nodes.add(refIds(node));
      return this;
    }

    /**
     * @param edgeId the edge's id
     * @param from the node it leaves ({@code $start} for the flow's start)
     * @param to the node it reaches ({@code $end} for the flow's end)
     * @return this
     */
    public Builder edge(String edgeId, String from, String to) {
      Map<String, Object> edge = new LinkedHashMap<>();
      edge.put("id", edgeId);
      edge.put("from", from);
      edge.put("to", to);
      edges.add(edge);
      return this;
    }

    /**
     * Another field of the flow ({@code name}, {@code description}, {@code maxParallelism}, {@code
     * metadata}, {@code output}).
     *
     * @param field the field
     * @param value its value
     * @return this
     */
    public Builder set(String field, Object value) {
      entry.put(field, value);
      return this;
    }

    /** @return the flow
     * @throws IllegalStateException when its version is missing */
    public Flow build() {
      if (!entry.containsKey("version")) {
        throw new IllegalStateException("flow " + id + ": version is required");
      }
      Map<String, Object> e = new LinkedHashMap<>(entry);
      e.put("id", id);
      e.put("nodes", List.copyOf(nodes));
      e.put("edges", List.copyOf(edges));
      return new Flow(definedIn, id, e);
    }
  }
}
