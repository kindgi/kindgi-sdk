// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The docs theme's own colour pairs, checked in both themes: 4.5:1 for text
 * (WCAG AA), 3:1 for a component edge (WCAG 1.4.11).
 *
 * `pnpm run check:tokens` checks the tokens' own pairs (design/tokens.json).
 * This checks what the docs make from them:
 *   - the colours src/styles/kindgi.css mixes: inline code, the sidebar's
 *     current page and the "Preview" badge on it, the accent tint, a field;
 *   - every syntax colour the code blocks show on the code surface, from the
 *     theme ec.config.mjs names, as it customizes it.
 *
 * Usage: node scripts/check-theme-contrast.mjs (site:build runs it first).
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadShikiTheme } from '@astrojs/starlight/expressive-code';
import { contrast } from '../../scripts/check-tokens.mjs';
import ecConfig from '../ec.config.mjs';

const TOKENS = JSON.parse(
  readFileSync(new URL('../../design/tokens.json', import.meta.url), 'utf8'),
);
const THEMES = ['light', 'dark'];
const HEX6 = /^#[0-9a-f]{6}$/i;

/** `color-mix(in srgb, a share, b)` of two `#RRGGBB` colours, as kindgi.css writes it. */
export function mix(a, share, b) {
  const channel = (hex, i) => Number.parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5]
    .map((i) => Math.round(channel(a, i) * share + channel(b, i) * (1 - share)))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

/** The pairs kindgi.css makes in one theme: [what, foreground, background, minimum]. */
export function themePairs(colors, theme) {
  const c = Object.fromEntries(Object.entries(colors).map(([name, v]) => [name, v[theme]]));
  const current = mix(c.text, 0.06, c.card);
  return [
    ['text on inline code (text 8% in the page)', c.text, mix(c.text, 0.08, c.page), 4.5],
    ["text on the sidebar's current page (text 6% on the card)", c.text, current, 4.5],
    ['"Preview" (action) on the sidebar\'s current page', c.action, current, 4.5],
    ['text on the accent tint (action 12% in the card)', c.text, mix(c.action, 0.12, c.card), 4.5],
    ['secondary text on a field (the search box)', c['text-2'], c.field, 4.5],
    // ec.config.mjs marks the selected code tab with the accent's light value in both themes.
    ['the selected code tab (accent) on code', colors.accent.light, c['code-bg'], 3],
  ];
}

/** Every foreground the code blocks' theme paints with, as ec.config.mjs customizes it. */
export async function codeColors(config = ecConfig) {
  const theme = await loadShikiTheme(config.themes[0]);
  const shown = config.customizeTheme?.(theme) ?? theme;
  const colors = new Set([shown.fg.toLowerCase()]);
  for (const rule of shown.settings ?? []) {
    const { foreground, background } = rule.settings ?? {};
    // A rule with its own background (a diff line) is read on that, not on the code surface.
    if (foreground !== undefined && background === undefined && HEX6.test(foreground)) {
      colors.add(foreground.toLowerCase());
    }
  }
  return [...colors];
}

/** Every pair below its minimum, in either theme. */
export async function contrastFailures(colors = TOKENS.colors) {
  const failures = [];
  const code = await codeColors();
  if (code.length < 2)
    failures.push(`the code theme gave ${code.length} colour(s): expected its palette`);
  for (const theme of THEMES) {
    const pairs = [
      ...themePairs(colors, theme),
      ...code.map((fg) => [`syntax colour ${fg} on code`, fg, colors['code-bg'][theme], 4.5]),
    ];
    for (const [what, fg, bg, min] of pairs) {
      const ratio = contrast(fg, bg);
      if (ratio < min)
        failures.push(`${theme}: ${what}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, under ${min}:1`);
    }
  }
  return failures;
}

async function main() {
  const failures = await contrastFailures();
  if (failures.length > 0) {
    console.error(`check-theme-contrast: ${failures.length} pair(s) under their minimum:`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log('check-theme-contrast: every docs colour pair meets its minimum, in both themes.');
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main();
}
