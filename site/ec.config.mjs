// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// Expressive Code's options, here rather than in astro.config.mjs so the
// `<Code>` component can load them too. Code sits on the neutral code surface
// in both themes (design/README.md, "Code"), so one dark syntax theme serves
// both, and strings take the accent. The tokens and the CLI's version are
// imported, never read from disk: the `<Code>` component (the API reference's
// examples) loads this file bundled, where a path from `import.meta.url` no
// longer reaches them, and it then falls back to Expressive Code's defaults.
import { defineEcConfig } from '@astrojs/starlight/expressive-code';
import tokens from '../design/tokens.json' with { type: 'json' };
import cli from '../packages/cli/package.json' with { type: 'json' };
import { versionInCode } from './scripts/versioned-pages.mjs';

// The design tokens' source: the accent is a token, not a colour of our own.
const accent = tokens.colors.accent.dark;

export default defineEcConfig({
  // `{{kindgi.version}}` in a code block, filled before highlighting.
  plugins: [versionInCode(cli.version)],
  themes: ['github-dark-default'],
  // Recolour the rule for plain strings only: the theme lists comments,
  // regular expressions and links under string scopes too, and those keep
  // their own colours.
  customizeTheme: (theme) => {
    for (const rule of theme.settings ?? []) {
      if ([rule.scope ?? []].flat().includes('string')) {
        rule.settings = { ...rule.settings, foreground: accent };
      }
    }
    return theme;
  },
  styleOverrides: {
    borderRadius: '0',
    borderColor: 'var(--kg-rule)',
    codeBackground: 'var(--kg-code-bg)',
    codeForeground: 'var(--kg-code-text)',
    codeFontFamily: 'var(--kg-font-mono)',
    uiFontFamily: 'var(--kg-font)',
    frames: {
      editorBackground: 'var(--kg-code-bg)',
      editorTabBarBackground: 'var(--kg-code-bg)',
      editorActiveTabBackground: 'var(--kg-code-bg)',
      editorActiveTabIndicatorBottomColor: accent,
      editorActiveTabIndicatorTopColor: 'transparent',
      terminalBackground: 'var(--kg-code-bg)',
      terminalTitlebarBackground: 'var(--kg-code-bg)',
      frameBoxShadowCssValue: 'none',
    },
  },
});
