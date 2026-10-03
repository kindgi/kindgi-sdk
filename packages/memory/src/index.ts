// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// ============ Wire types ============
export type {
  Fact,
  MemoryScope,
  Retention,
  Source,
  SourceFreshness,
  SourceRefresh,
} from './types.js';

// ============ Log types ============
export { LOG_KINDS } from './log.js';
export type { LogEntry, LogKind } from './log.js';

// ============ Retrieval types ============
export type { RetrievalHit } from './retrieval.js';

// ============ Errors ============
export type {
  FactNotFoundError,
  InvalidFactError,
  InvalidLogEntryError,
  LogNotFoundError,
  MemoryError,
  PersistenceError,
  RefreshHandlerMissingError,
  RetentionViolationError,
} from './errors.js';

// ============ MemoryQueryBinding — caller-plugged data-access surface ============
export type {
  AppendLogInput,
  ListFactsInput,
  MemoryQueryBinding,
  ReadLogInput,
  SearchByKeywordInput,
  SearchBySemanticInput,
} from './memory-binding.js';
