// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// ============ Wire types ============
export { EDGE_KINDS, NODE_KINDS } from './types.js';
export type {
  EdgeKind,
  KeyMaterial,
  KeyProvider,
  NodeKind,
  Provenance,
  ProvenanceEdge,
  ProvenanceNode,
  Signature,
} from './types.js';

// ============ Errors ============
export type {
  InvalidProvenanceError,
  MissingSignatureError,
  PersistenceError,
  ProvenanceError,
  ProvenanceNotFoundError,
  SignatureVerificationError,
  SigningNotSupportedError,
  UnknownKeyError,
} from './errors.js';

// ============ DAG builder ============
export { newBuilder } from './build.js';
export type { BuilderOptions, ProvenanceBuilder } from './build.js';

// ============ Sign + verify ============
export { signProvenance, verifyExported, verifyProvenance } from './sign.js';

// ============ Canonicalization ============
export { signingBytes } from './canonical.js';

// ============ Export / import (round-trippable JSON) ============
export { exportProvenance, importProvenance } from './export.js';

// ============ Versioning envelope ============
export {
  CURRENT_PROVENANCE_PAYLOAD_VERSION,
  EnvelopeThrown,
  unwrap,
  unwrapOrThrow,
  wrap,
} from './versioning.js';
export type {
  EnvelopeError,
  MalformedEnvelopeError,
  UnsupportedPayloadVersionError,
} from './versioning.js';

// ============ ProvenanceEmitBinding — caller-plugged emit surface ============
export type { ProvenanceEmitBinding } from './emit-binding.js';
