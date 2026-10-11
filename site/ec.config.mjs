// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// Expressive Code's options, here rather than in astro.config.mjs so the
// `<Code>` component can load them too.
import { defineEcConfig } from '@astrojs/starlight/expressive-code';
import { docsVersion, versionInCode } from './scripts/versioned-pages.mjs';

export default defineEcConfig({
  // `{{kindgi.version}}` in a code block, filled before highlighting.
  plugins: [versionInCode(docsVersion())],
});
