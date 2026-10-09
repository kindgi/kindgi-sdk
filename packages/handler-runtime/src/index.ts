// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export type {
  CheckInvocationSpec,
  CheckModule,
  HandlerContext,
  HandlerError,
  HandlerErrorCode,
  HandlerFn,
  HandlerModule,
  RunCheckOptions,
  RunHandlerOptions,
  ToolInvocationSpec,
} from './handler-runner.js';
export { runCheck, runHandler } from './handler-runner.js';

export type {
  DiscoveryConfig,
  Index,
  IndexedAgent,
  IndexedFlow,
  IndexedGuardrail,
  IndexedTool,
  IndexEnvelopeVersion,
  IndexerError,
  IndexerErrorCode,
  IndexerWarning,
  IndexerWarningCode,
  IndexerReport,
  PrimitiveKind,
  RunIndexerOptions,
  KindgiConfig,
  KindgiProviderDeclaration,
  KindgiConfigFile,
  LoadKindgiConfigOptions,
  JvmLanguage,
  PackLanguage,
} from './kindgi-index.js';
export {
  DEFAULT_DISCOVERY,
  DEFAULT_JAVA_DISCOVERY,
  DEFAULT_SCALA_DISCOVERY,
  DEFAULT_PYTHON_DISCOVERY,
  HELP_TEXT as KINDGI_INDEX_HELP_TEXT,
  INDEX_ENVELOPE_VERSION,
  KERNEL_PAYLOAD_VERSION,
  KINDGI_CONFIG_FILENAMES,
  KINDGI_JSON_CONFIG_FILENAME,
  PYPROJECT_FILENAME,
  RESERVED_CHECK_IDS,
  findKindgiConfig,
  isJvmLanguage,
  loadKindgiConfig,
  packLanguage,
  resolveDiscovery,
  main as kindgiIndexMain,
  runIndexer,
} from './kindgi-index.js';
export type { PackEnvCheck, PackEnvConfig, PackEnvDeclaration, PackEnvResult } from './pack-env.js';
export {
  PACK_ENV_CHECK_VAR,
  PACK_ENV_NAME,
  RESERVED_ENV_PREFIX,
  missingPackEnv,
  parsePackEnvCheck,
  resolvePackEnv,
} from './pack-env.js';
export {
  TEST_FILE_REGEX,
  createGlobMatcher,
  discoveryRoots,
  globStaticPrefix,
  globToRegex,
} from './discovery.js';
