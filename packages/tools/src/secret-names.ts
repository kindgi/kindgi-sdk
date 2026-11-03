// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ToolManifest } from './types.js';

/**
 * Every secret a tool uses, by name: the ones its code declares
 * (`needsSpec.secrets`) and the one a declarative HTTP tool sends
 * (`spec.authorization.secretRef`; a `connection` one sends no secret).
 * Sorted, each once. A runtime checks
 * them against what may never be a tool's, such as a model provider's key.
 */
export function toolSecretNames(manifest: Pick<ToolManifest, 'needsSpec' | 'spec'>): string[] {
  const names = new Set(Object.keys(manifest.needsSpec?.secrets ?? {}));
  const auth = manifest.spec?.authorization;
  if (auth !== undefined && auth.kind !== 'connection') names.add(auth.secretRef.name);
  return [...names].sort();
}
