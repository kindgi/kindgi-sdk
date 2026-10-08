// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { satteri } from '@astrojs/markdown-satteri';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLlmsTxt from 'starlight-llms-txt';
import starlightOpenAPI, { createOpenAPISidebarGroup } from 'starlight-openapi';
import { createStarlightTypeDocPlugin } from 'starlight-typedoc';

// Each released minor line is built from its git tag under its own base
// (`/v0.1/`), the newest also at the root. Content links are relative, so a
// page works under any base.
const base = process.env.KINDGI_DOCS_BASE ?? '/';
// A private preview of unreleased docs (scripts/build-preview.mjs).
const preview = process.env.PUBLIC_KINDGI_DOCS_PREVIEW === '1';
// Only the latest release's docs (served at the root) are indexed: an older
// line or a preview would compete with them in search results.
const indexed = base === '/' && !preview;

// The guides, one collapsible group per area, in reading order.
const guideAreas = [
  ['Tools', 'tools'],
  ['Agents', 'agents'],
  ['Models', 'models'],
  ['Flows', 'flows'],
  ['Runs', 'runs'],
  ['Orgs and projects', 'projects'],
  ['Webhooks', 'webhooks'],
  ['Guardrails', 'guardrails'],
  ['Approvals', 'approvals'],
  ['Secrets and env', 'secrets'],
  ['Sign-in', 'sso'],
  ['Cost and provenance', 'observability'],
  ['Evals', 'evals'],
];

// The HTTP API reference: every route and schema, from the API's own spec.
const httpApi = createOpenAPISidebarGroup();

// The TypeScript reference: typedoc over each package's public entry points.
const [sdkTypeDoc, sdkReference] = createStarlightTypeDocPlugin();
// The sub-paths, as users import them. `@kindgi/sdk` itself only
// re-exports them, so it gets no pages of its own.
const sdkEntryPoints = ['define', 'client', 'types', 'webhooks'].map(
  (entry) => `../packages/sdk/src/${entry}.ts`,
);

export default defineConfig({
  site: 'https://docs.kindgi.com',
  base,
  trailingSlash: 'always',
  // Keep `--flag` and quotes as typed: smart punctuation would turn a CLI
  // flag in prose into an en dash.
  markdown: { processor: satteri({ features: { smartPunctuation: false } }) },
  integrations: [
    starlight({
      title: 'Kindgi',
      description:
        'Build agents and flows in your own code, run them durably, and keep every step on the record.',
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/kindgi/kindgi-sdk' }],
      editLink: { baseUrl: 'https://github.com/kindgi/kindgi-sdk/edit/main/site/' },
      customCss: ['./src/styles/kindgi.css'],
      components: {
        // The version menu and the "not the latest" notice.
        ThemeSelect: './src/components/ThemeSelect.astro',
        Banner: './src/components/Banner.astro',
        // "Edit page" (hand-written pages) and "Report a problem" (every page).
        EditLink: './src/components/EditLink.astro',
      },
      plugins: [
        // `llms.txt`, `llms-full.txt` and `llms-small.txt` for AI tools, per
        // version (each build writes its own under its base).
        starlightLlmsTxt({
          projectName: 'Kindgi',
          details: [
            'Kindgi runs AI agents and flows beside your application. You define tools (your own',
            'TypeScript or Python code), agents and flows in a pack; the Kindgi runtime runs them',
            'durably, calls your code over HTTP, and records every step in a journal. The SDKs',
            '(`@kindgi/sdk` on npm, `kindgi` on PyPI) and the CLI (`@kindgi/cli` on npm, `kindgi-cli`',
            'on PyPI) are Apache-2.0. TypeScript projects run the CLI as `pnpm exec kindgi`; Python',
            'projects as `uv run kindgi`.',
          ].join('\n'),
          customSets: [
            {
              label: 'Start',
              paths: ['start/**'],
              description: 'install, quickstarts, existing apps',
            },
            {
              label: 'Tutorials',
              paths: ['tutorials/**'],
              description: 'build something, step by step',
            },
            { label: 'Guides', paths: ['guides/**'], description: 'how to do one thing' },
            { label: 'Concepts', paths: ['concepts/**'] },
            { label: 'Deploy', paths: ['deploy/**'] },
            { label: 'CLI reference', paths: ['reference/cli/**'] },
            { label: 'Python SDK reference', paths: ['reference/python/**'] },
          ],
          promote: ['start/**', 'concepts/**', 'guides/**'],
          demote: ['reference/**', 'contributing/**'],
          // The small file is for short contexts: the TypeScript reference
          // (typedoc, many pages) stays in the full one.
          exclude: ['reference/typescript/**', 'reference/packages/**', 'contributing/**'],
          // Heading anchors ("Section titled …") are page chrome, not content.
          customSelectors: { all: ['.sl-anchor-link'] },
        }),
        starlightOpenAPI([
          {
            base: 'reference/api',
            // The API's spec with display names for its tags
            // (scripts/reference/openapi.mjs).
            schema: './generated/openapi.json',
            sidebar: {
              label: 'HTTP API',
              group: httpApi,
              operations: { badges: true },
            },
          },
        ]),
        sdkTypeDoc({
          entryPoints: sdkEntryPoints,
          tsconfig: '../packages/sdk/tsconfig.json',
          output: 'reference/typescript/sdk',
          sidebar: { label: '@kindgi/sdk', collapsed: true },
          typeDoc: {
            // Module overviews as `index` pages: starlight-typedoc drops
            // per-module README pages when no readme is configured.
            entryFileName: 'index',
            // Source links would point at build output inside the repository.
            disableSources: true,
            excludePrivate: true,
            excludeInternal: true,
            categorizeByGroup: true,
            parametersFormat: 'table',
            propertiesFormat: 'table',
            enumMembersFormat: 'table',
            typeDeclarationFormat: 'table',
            useCodeBlocks: true,
          },
        }),
      ],
      head: [
        ...(indexed ? [] : [{ tag: 'meta', attrs: { name: 'robots', content: 'noindex' } }]),
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:wght@500;600&display=swap',
          },
        },
      ],
      sidebar: [
        { label: 'Start', items: [{ autogenerate: { directory: 'start' } }] },
        { label: 'Tutorials', items: [{ autogenerate: { directory: 'tutorials' } }] },
        {
          label: 'Guides',
          items: [
            { label: 'Overview', link: '/guides/' },
            ...guideAreas.map(([label, directory]) => ({
              label,
              collapsed: true,
              items: [{ autogenerate: { directory: `guides/${directory}` } }],
            })),
          ],
        },
        { label: 'Concepts', items: [{ autogenerate: { directory: 'concepts' } }] },
        { label: 'Deploy', items: [{ autogenerate: { directory: 'deploy' } }] },
        {
          label: 'Reference',
          items: [
            { label: 'Overview', link: '/reference/' },
            httpApi,
            { label: 'TypeScript', collapsed: true, items: [sdkReference] },
            {
              label: 'Python',
              collapsed: true,
              items: [{ autogenerate: { directory: 'reference/python' } }],
            },
            {
              label: 'CLI',
              collapsed: true,
              items: [{ autogenerate: { directory: 'reference/cli' } }],
            },
            { label: 'Environment variables', link: '/reference/env-vars/' },
            {
              label: 'Packages',
              collapsed: true,
              items: [{ autogenerate: { directory: 'reference/packages' } }],
            },
            {
              label: 'JSON Schemas',
              collapsed: true,
              items: [{ autogenerate: { directory: 'reference/schemas' } }],
            },
          ],
        },
        { label: 'Contributing', items: [{ autogenerate: { directory: 'contributing' } }] },
      ],
    }),
  ],
});
