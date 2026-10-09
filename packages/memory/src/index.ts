// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// ============ Wire types ============
export type {
  Fact,
  FactAttribution,
  FactGeneratedBy,
  FactInvalidationReason,
  FactSubject,
  FactTrust,
  MemoryReaders,
  MemoryScope,
  Retention,
  Source,
  SourceFreshness,
  SourceRefresh,
} from './types.js';

// ============ The scope guard ============
export { isReadableBy } from './readers.js';

// ============ Hybrid retrieval ============
export { RRF_K, fuseByRank } from './fusion.js';
export type { Fused } from './fusion.js';

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

// ============ Agent memory writes (the `remember` tool) ============
export type {
  MemoryRememberBinding,
  RememberFactInput,
  RememberFactResult,
  RememberReviewReason,
  RememberedContent,
} from './remember.js';

// ============ MemoryQueryBinding — caller-plugged data-access surface ============
export type {
  AppendLogInput,
  ListFactsInput,
  MemoryQueryBinding,
  ReadLogInput,
  SearchByKeywordInput,
  SearchBySemanticInput,
} from './memory-binding.js';
