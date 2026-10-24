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
import { excerpts } from './scripts/excerpts.mjs';
import { versionInCode } from './scripts/versioned-pages.mjs';

// The design tokens' source: code shows three colours, as the design sheet
// does: the code text, comments at 55% of it, and strings in the accent.
const { accent, 'code-bg': codeBg, 'code-text': codeText } = tokens.colors;

/** `color-mix(in srgb, a share, b)` of two `#RRGGBB` colours. */
function mix(a, share, b) {
  const channel = (hex, i) => Number.parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5]
    .map((i) => Math.round(channel(a, i) * share + channel(b, i) * (1 - share)))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`;
}

// One syntax theme serves both page themes, so each colour is one value. Comments
// are 55% of the code text on the light theme's code surface, the lighter one:
// mixed on the dark surface, they'd fall under 4.5:1 on the light.
const comment = mix(codeText.light, 0.55, codeBg.light);

export default defineEcConfig({
  // `{{kindgi.version}}` in a code block, filled before highlighting. An
  // excerpt (```` ```ts excerpt ````, or a block with `…`) gets no copy button.
  plugins: [versionInCode(cli.version), excerpts()],
  themes: ['github-dark-default'],
  // Every rule to the code text, but comments and plain strings. A rule with
  // its own background (a diff line) keeps its colours.
  customizeTheme: (theme) => {
    for (const rule of theme.settings ?? []) {
      const scopes = [rule.scope ?? []].flat();
      const { foreground, ...rest } = rule.settings ?? {};
      if (foreground === undefined || rest.background !== undefined) continue;
      if (scopes.some((scope) => scope === 'comment' || scope.startsWith('comment.'))) {
        rule.settings = { ...rest, foreground: comment };
      } else if (scopes.includes('string')) {
        rule.settings = { ...rest, foreground: accent.dark };
      } else {
        rule.settings = rest;
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
      editorActiveTabIndicatorBottomColor: accent.light,
      editorActiveTabIndicatorTopColor: 'transparent',
      terminalBackground: 'var(--kg-code-bg)',
      terminalTitlebarBackground: 'var(--kg-code-bg)',
      frameBoxShadowCssValue: 'none',
    },
  },
});
