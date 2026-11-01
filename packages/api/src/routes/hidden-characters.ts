// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The refusal's words for a name or a label with a hidden character
 * (`hasHiddenCharacters` in `@kindgi/types`), the same on every route.
 */
export function hiddenCharactersMessage(field: string): string {
  return `\`${field}\` must not contain control, format or invisible characters`;
}
