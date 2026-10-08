// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export type {
  AppendMessageInput,
  ConversationBinding,
  ConversationPage,
  ConversationPageCursor,
  ListConversationsInput,
  ListConversationsPageInput,
  OpenConversationInput,
  ReadMessagesInput,
} from './conversation-binding.js';
export type {
  RunSnapshotBinding,
  RunSnapshotRecord,
  RunSnapshotWriteInput,
} from './run-snapshot-binding.js';
export { defineAgent } from './define.js';
export {
  BLOCK_KINDS,
  MODEL_SETTINGS_SCHEMA,
  settingsSchemaIssues,
  validateBlock,
} from './blocks.js';
export type {
  BlockDefinition,
  BlockIssue,
  BlockKind,
  BlockReader,
  InvalidBlock,
  ModelSettings,
  PromptBlockContent,
  SettingsBlockContent,
} from './blocks.js';
export type { DefineAgentSpec } from './define.js';
export { resolveEffectiveHitlPolicy } from './hitl-policy.js';
export {
  AGENT_GATE_SUBJECTS,
  SESSION_GATE_SUBJECT,
  TOOL_CALL_GATE_SUBJECT,
  readGateDecision,
} from './handlers/gate-decision.js';
export type { GateDecision, GateDecisionValue } from './handlers/gate-decision.js';
export type { EffectiveHitlPolicy } from './hitl-policy.js';
export { agentStepOutput, invokeAgent, resumeAgentTurn } from './invoke.js';
export { parseFailureMessage, turnFailureMessage } from './handlers/errors.js';
export { isReadOnlyTool } from './handlers/replay.js';
export { SESSION_GATE_RECORD } from './handlers/setup.js';
export type {
  ReplayApproval,
  ReplayBinding,
  ReplayToolDecision,
  ReplayToolInput,
  ReplayToolTrace,
  ReplayTurnRef,
  ReplayTurnReport,
} from './handlers/replay.js';
export type {
  AgentStepOutput,
  AgentTurnAbortedError,
  AgentTurnResult,
  AgentTurnUsage,
  AgentTurnWarning,
  BudgetExceededError,
  CapabilityRoutingError,
  InvokeAgentBindings,
  InvokeAgentError,
  InvokeAgentInput,
  ModelInvocationError,
  OutputSchemaViolationError,
  ResumeAgentTurnInput,
  RunSnapshotError,
  ToolInvocationError,
  UnresolvedToolError,
} from './invoke.js';
export {
  buildRunTrace,
  categorizeOutcomes,
  evaluateGate,
  evaluateSessionGate,
  resolveGuardrails,
} from './guardrails-gate.js';
export type {
  HitlRequiredError,
  GuardrailViolationError,
  GuardrailsBindings,
  SessionGateResult,
  UnresolvedGuardrailError,
} from './guardrails-gate.js';
export { persistProvenance } from './provenance-emit.js';
export type { ProvenanceBindings } from './provenance-emit.js';
export type {
  AgentMessageEvent,
  GuardrailViolatedEvent,
  ModelCallCompletedEvent,
  ModelCallStartedEvent,
  OnTurnEvent,
  RetrievalCompletedEvent,
  ToolCompletedEvent,
  ToolFailedEvent,
  ToolStartedEvent,
  TurnCompletedEvent,
  TurnEvent,
  TurnFailedEvent,
  TurnStartedEvent,
} from './streaming.js';
export { AUTO_INJECTED_VARS, renderInstructions } from './prompt.js';
export { formatRetrievedForPrompt, runMemoryReaders, runRetrievals } from './retrieval.js';
export type { RetrievalRun } from './retrieval.js';
export type { RetrievalBindings } from './retrieval.js';
export type {
  MissingParameterError,
  PromptRenderError,
  RenderContext,
  RenderFailureError,
  RenderResult,
} from './prompt.js';
export { pinChanges, pinsDigest } from './pins.js';
export type {
  AgentDerivation,
  AgentDerivationReason,
  AgentPins,
  PinChange,
  PinSet,
} from './pins.js';
export { createAgentRegistry } from './registry.js';
export type { AgentRegistry } from './registry.js';
export {
  AGENTS_TENANT_SCOPED_TABLES,
  agentConversations,
  agentRunSnapshots,
} from './schema.js';
export type {
  AgentConversationRow,
  AgentRunSnapshotRow,
  NewAgentConversationRow,
  NewAgentRunSnapshotRow,
} from './schema.js';
export type {
  Agent,
  AgentBindings,
  AgentId,
  AgentOutputSpec,
  BlockRef,
  Conversation,
  ConversationId,
  ConversationMessage,
  ConversationPolicy,
  MessageRole,
  PromptParameter,
  PromptRef,
  RetrievalIntent,
  RetrievedFact,
  ToolRef,
  TurnBudget,
} from './types.js';
export { DEFAULT_TOOL_ERRORS, effectiveToolErrorPolicy } from './handlers/tool-errors.js';
export type { ToolErrorPolicy, ToolErrorResult } from './handlers/tool-errors.js';
export type { ToolErrorKind, ToolErrorsSpec } from '@kindgi/policy-contract';
export type {
  AgentAlreadyRegisteredError,
  AgentError,
  AgentNotFoundError,
  AgentVersionMismatchError,
  ConversationClosedError,
  ConversationNotFoundError,
  InvalidAgentError,
  InvalidMessageError,
  PersistenceError,
} from './errors.js';
export { CURRENT_AGENTS_PAYLOAD_VERSION, unwrap, unwrapOrThrow, wrap } from './versioning.js';
export type {
  EnvelopeError,
  MalformedEnvelopeError,
  UnsupportedPayloadVersionError,
} from './versioning.js';
export { AGENTS_MIGRATIONS_DIR } from './migrations-dir.js';

// ============ Built-in agent-turn flow ============
// The flow every agent turn runs on, plus its node IDs — the same IDs
// that appear in run journals, exported so consumers can match on them.
export {
  AGENT_LOOP_NODE,
  AGENT_TURN_FLOW,
  AGENT_TURN_FLOW_ID,
  AGENT_TURN_FLOW_VERSION,
  AGENT_TURN_LOOP_MAX_ITERATIONS,
  BUDGET_CHECK_NODE,
  BUILD_INITIAL_MESSAGES_NODE,
  COMPOSE_RESULT_NODE,
  DISPATCH_TOOLS_NODE,
  EVALUATE_GUARDRAILS_NODE,
  MODEL_CALL_NODE,
  PERSIST_FINAL_MESSAGE_NODE,
  PERSIST_PROVENANCE_NODE,
  PERSIST_USER_MESSAGE_NODE,
  RENDER_PROMPT_NODE,
  RUN_RETRIEVALS_NODE,
  SETUP_NODE,
} from './agent-turn-flow.js';
