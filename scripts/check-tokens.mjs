#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Kindgi's design tokens: `design/tokens.json` is the one source for the
 * website, the docs and the console; `design/tokens.css` is written from it.
 *
 * This check fails when:
 *   - `design/tokens.css` isn't what `tokens.json` writes (run
 *     `pnpm run tokens:build` after editing the JSON);
 *   - a colour isn't a `#RRGGBB` value, or lacks its light or dark value;
 *   - a pair in `contrast.pairs` misses its minimum in either theme
 *     (4.5 is WCAG AA for text, 3 is WCAG 1.4.11 for graphics and edges).
 *
 * The CSS sets the light values on `:root`, and the dark values both under
 * `prefers-color-scheme: dark` (unless the page chose light, with
 * `data-theme="light"` or a `light` class) and for an explicit choice
 * (`data-theme="dark"`, as Starlight sets it, or a `dark` class, as shadcn/ui
 * sets it). Every name is prefixed (`--kg-…`) so it never meets a surface's
 * own variables.
 *
 * Usage: `pnpm run check:tokens` (CI's lint job runs it);
 *        `pnpm run tokens:build` writes `design/tokens.css`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JSON_PATH = join(ROOT, 'design', 'tokens.json');
const CSS_PATH = join(ROOT, 'design', 'tokens.css');

const HEX = /^#[0-9A-F]{6}$/;
const THEMES = ['light', 'dark'];

/** WCAG relative luminance of a `#RRGGBB` colour. */
export function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two `#RRGGBB` colours, 1 to 21. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Problems with the tokens' shape: bad or missing colours, pairs naming unknown roles. */
export function shapeProblems(tokens) {
  const problems = [];
  for (const [name, color] of Object.entries(tokens.colors)) {
    for (const theme of THEMES) {
      if (!HEX.test(color[theme] ?? '')) {
        problems.push(
          `colors.${name}.${theme}: ${JSON.stringify(color[theme])} is not a #RRGGBB value (upper case)`,
        );
      }
    }
  }
  for (const [fg, bg] of tokens.contrast.pairs) {
    for (const role of [fg, bg]) {
      if (!(role in tokens.colors))
        problems.push(`contrast pair ${fg} on ${bg}: no colour "${role}"`);
    }
  }
  return problems;
}

/** Every checked pair below its minimum, in either theme. */
export function contrastFailures(tokens) {
  const failures = [];
  for (const [fg, bg, min] of tokens.contrast.pairs) {
    for (const theme of THEMES) {
      const ratio = contrast(tokens.colors[fg][theme], tokens.colors[bg][theme]);
      if (ratio < min) failures.push({ theme, fg, bg, ratio, min });
    }
  }
  return failures;
}

/** The CSS `tokens.json` writes. */
export function renderCss(tokens) {
  const v = (name) => `--${tokens.prefix}-${name}`;
  const colors = Object.entries(tokens.colors);
  // Hex in lower case, as the formatter writes CSS.
  const block = (theme) => colors.map(([name, c]) => `  ${v(name)}: ${c[theme].toLowerCase()};`);
  const lines = [
    '/* SPDX-License-Identifier: Apache-2.0 */',
    '/* Copyright (C) 2026 Kindgi Inc. */',
    '',
    "/* Kindgi's design tokens, light and dark. Written from design/tokens.json by",
    '   `pnpm run tokens:build`: edit the JSON, not this file. See design/README.md. */',
    '',
    ':root {',
    '  color-scheme: light;',
    ...colors.flatMap(([name, c]) => [
      `  /* ${c.use} */`,
      `  ${v(name)}: ${c.light.toLowerCase()};`,
    ]),
    ...Object.entries(tokens.values).flatMap(([name, x]) => [
      `  /* ${x.use} */`,
      `  ${v(name)}: ${x.value};`,
    ]),
    '}',
    '',
    "/* Dark, when the system asks for it and the page hasn't chosen light */",
    '@media (prefers-color-scheme: dark) {',
    '  :root:not([data-theme="light"]):not(.light) {',
    '    color-scheme: dark;',
    ...block('dark').map((l) => `  ${l}`),
    '  }',
    '}',
    '',
    '/* Dark, when the page chose it: data-theme (Starlight) or a dark class (shadcn/ui) */',
    ':root[data-theme="dark"],',
    ':root.dark {',
    '  color-scheme: dark;',
    ...block('dark'),
    '}',
    '',
  ];
  return lines.join('\n');
}

function main(argv) {
  const tokens = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
  const problems = shapeProblems(tokens);
  if (problems.length > 0) {
    console.error(`design/tokens.json:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  const css = renderCss(tokens);
  if (argv.includes('--write')) {
    writeFileSync(CSS_PATH, css);
    console.log('Wrote design/tokens.css.');
  }
  let ok = true;
  const current = existsSync(CSS_PATH) ? readFileSync(CSS_PATH, 'utf8') : '';
  if (current !== css) {
    console.error(
      'design/tokens.css is out of date with design/tokens.json: run `pnpm run tokens:build`.',
    );
    ok = false;
  }
  const failures = contrastFailures(tokens);
  for (const f of failures) {
    console.error(`${f.theme}: ${f.fg} on ${f.bg} is ${f.ratio.toFixed(2)}:1, under ${f.min}:1`);
  }
  if (failures.length > 0) ok = false;
  if (!ok) process.exit(1);
  const pairs = tokens.contrast.pairs.length;
  console.log(
    `Design tokens: ${Object.keys(tokens.colors).length} colours; ${pairs} pairs meet their contrast in light and dark.`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
