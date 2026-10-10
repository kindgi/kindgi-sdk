// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ToolManifest } from './types.js';

/**
 * Every secret a tool uses, by name: the ones its code declares
 * (`needsSpec.secrets`) and the one a declarative HTTP tool sends
 * (`spec.authorization.secretRef`). Sorted, each once. A runtime checks
 * them against what may never be a tool's, such as a model provider's key.
 */
export function toolSecretNames(manifest: Pick<ToolManifest, 'needsSpec' | 'spec'>): string[] {
  const names = new Set(Object.keys(manifest.needsSpec?.secrets ?? {}));
  const ref = manifest.spec?.authorization?.secretRef;
  if (ref !== undefined) names.add(ref.name);
  return [...names].sort();
}
