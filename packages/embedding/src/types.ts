// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Turn text into a fixed-length vector suitable for cosine similarity.
 *
 * `describe().model` is the stable identifier the storage layer keys
 * embeddings by: stored vectors are tagged with it and queries filter
 * on it. Never rename `model` across versions — that would silently
 * orphan already-indexed vectors.
 *
 * `dimensions()` MUST equal the length of every `embed()` result. Callers
 * use this at boot to size HNSW indexes; a mid-flight change desyncs the
 * index. If you need to change dims, register under a new `model` and
 * migrate old rows separately.
 *
 * No default provider ships with `@kindgi/embedding`; register one
 * at boot (the Kindgi runtime offers a self-hosted local-model
 * provider).
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  dimensions(): number;
  describe(): { readonly name: string; readonly version: string; readonly model: string };
}
