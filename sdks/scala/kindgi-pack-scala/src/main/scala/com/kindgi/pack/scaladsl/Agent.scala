// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.scaladsl

import scala.reflect.ClassTag

/** Builds an agent. */
object Agent {
  /** @param id the agent's id */
  def apply(id: String): AgentBuilder = new AgentBuilder(com.kindgi.pack.Agent.define(id))
}

/** An agent being built; {@code build} finishes it. */
final class AgentBuilder private[scaladsl] (b: com.kindgi.pack.Agent.Builder) {
  def version(version: String): AgentBuilder = new AgentBuilder(b.version(version))
  def name(name: String): AgentBuilder = new AgentBuilder(b.name(name))
  def instructions(text: String): AgentBuilder = new AgentBuilder(b.instructions(text))
  def instructions(instructions: Map[String, Any]): AgentBuilder = new AgentBuilder(b.instructions(JsonValues.javaMap(instructions)))
  def capability(capability: Map[String, Any]): AgentBuilder = new AgentBuilder(b.capability(JsonValues.javaMap(capability)))
  def tool(tool: Tool[_, _]): AgentBuilder = new AgentBuilder(b.tool(tool))
  def tool(id: String, version: String): AgentBuilder = new AgentBuilder(b.tool(id, version))
  def guardrail(guardrail: Guardrail[_]): AgentBuilder = new AgentBuilder(b.guardrail(guardrail))
  def guardrail(id: String): AgentBuilder = new AgentBuilder(b.guardrail(id))
  def set(field: String, value: Any): AgentBuilder = new AgentBuilder(b.set(field, JsonValues.toJava(value)))
  /** The agent's structured output, as a case class. */
  def output[T](implicit output: ClassTag[T]): AgentBuilder = new AgentBuilder(b.output(output.runtimeClass))
  def build(): Agent = b.build()
}

/** Builds a flow. */
object Flow {
  /** @param id the flow's id */
  def apply(id: String): FlowBuilder = new FlowBuilder(com.kindgi.pack.Flow.define(id))
}

/** A flow being built; {@code build} finishes it. */
final class FlowBuilder private[scaladsl] (b: com.kindgi.pack.Flow.Builder) {
  def version(version: String): FlowBuilder = new FlowBuilder(b.version(version))
  def toolNode(nodeId: String, tool: Tool[_, _]): FlowBuilder = new FlowBuilder(b.toolNode(nodeId, tool))
  def agentNode(nodeId: String, agent: Agent): FlowBuilder = new FlowBuilder(b.agentNode(nodeId, agent))
  def node(node: Map[String, Any]): FlowBuilder = new FlowBuilder(b.node(JsonValues.javaMap(node)))
  def edge(edgeId: String, from: String, to: String): FlowBuilder = new FlowBuilder(b.edge(edgeId, from, to))
  def set(field: String, value: Any): FlowBuilder = new FlowBuilder(b.set(field, JsonValues.toJava(value)))
  def build(): Flow = b.build()
}
