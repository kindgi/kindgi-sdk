// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { satteri } from '@astrojs/markdown-satteri';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightOpenAPI, { createOpenAPISidebarGroup } from 'starlight-openapi';
import { createStarlightTypeDocPlugin } from 'starlight-typedoc';
import { agentMarkdown } from './scripts/agent-markdown.mjs';
import { typedocSignatures } from './scripts/reference/typedoc-signatures.mjs';
import { docsVersion, versionedPages } from './scripts/versioned-pages.mjs';

// Each released minor line is built from its git tag under its own base
// (`/v0.1/`), the newest also at the root. Content links are relative, so a
// page works under any base.
const base = process.env.KINDGI_DOCS_BASE ?? '/';
// A private preview of unreleased docs (scripts/build-preview.mjs).
const preview = process.env.PUBLIC_KINDGI_DOCS_PREVIEW === '1';
// Only the latest release's docs (served at the root) are indexed: an older
// line or a preview would compete with them in search results.
const indexed = base === '/' && !preview;
// The git ref this build describes (a release's tag, else `main`) and its
// version: hand-written pages' repository links and `{{kindgi.version}}`
// follow them (scripts/versioned-pages.mjs; code blocks in ec.config.mjs).
const ref = process.env.KINDGI_DOCS_REF ?? 'main';
const version = docsVersion();

const site = 'https://docs.kindgi.com';
const description =
  'Build agents and flows in your own code, run them durably, and keep every step on the record.';

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
  site,
  base,
  trailingSlash: 'always',
  // Keep `--flag` and quotes as typed: smart punctuation would turn a CLI
  // flag in prose into an en dash.
  markdown: { processor: satteri({ features: { smartPunctuation: false } }) },
  integrations: [
    // Before Starlight, so its search index reads the fixed pages.
    versionedPages({ ref, version }),
    // Every page as Markdown, and `llms.txt` with the files it lists, for
    // coding agents. After the version fixes, so the Markdown has them too;
    // each `llms*.txt` file names the version.
    agentMarkdown({
      site,
      base,
      title: 'Kindgi',
      version,
      description,
      details: [
        'Kindgi runs AI agents and flows beside your application. You define tools (your own',
        'TypeScript, Python, Java or Scala code), agents and flows in a pack; the Kindgi runtime',
        'runs them durably, calls your code over HTTP, and records every step in a journal. The',
        'SDKs (`@kindgi/sdk` on npm, `kindgi` on PyPI, and `com.kindgi:kindgi-pack`,',
        '`kindgi-pack-scala` and `kindgi-client` on Maven Central) and the CLI (`@kindgi/cli` on',
        'npm, `kindgi-cli` on PyPI) are Apache-2.0. TypeScript projects run the CLI as',
        '`pnpm exec kindgi`; Python projects as `uv run kindgi`; Java and Scala projects as',
        '`./kindgiw`.',
      ].join('\n'),
    }),
    starlight({
      title: 'Kindgi',
      description,
      favicon: '/favicon.svg',
      // The plum tile beside the title, as the favicon draws it: the action
      // colour of each theme (design/tokens.json).
      logo: {
        light: './src/assets/kindgi-tile-light.svg',
        dark: './src/assets/kindgi-tile-dark.svg',
      },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/kindgi/kindgi-sdk' }],
      editLink: { baseUrl: 'https://github.com/kindgi/kindgi-sdk/edit/main/site/' },
      // No "On this page" column beside the text.
      tableOfContents: false,
      // The fonts are served from the site itself (Fontsource), so a page asks no
      // other host for them: Plex Sans with its width axis (headings narrow to
      // --kg-narrow), its files kept in src/fonts so a release's docs branch can
      // take the theme without a dependency change, and Plex Mono. Then the
      // design tokens, and the theme that maps Starlight onto them.
      customCss: [
        './src/fonts/ibm-plex-sans-variable/wdth.css',
        '@fontsource/ibm-plex-mono/400.css',
        '@fontsource/ibm-plex-mono/500.css',
        '../design/tokens.css',
        './src/styles/kindgi.css',
      ],
      components: {
        // The title, with the page's Markdown version under it.
        PageTitle: './src/components/PageTitle.astro',
        // The version menu and the "not the latest" notice.
        ThemeSelect: './src/components/ThemeSelect.astro',
        Banner: './src/components/Banner.astro',
        // "Report a problem" and `llms.txt` (every page).
        EditLink: './src/components/EditLink.astro',
        // The next/previous links: the arrow and the page's title.
        Pagination: './src/components/Pagination.astro',
        // "See also" on the HTTP API's operation pages.
        MarkdownContent: './src/components/MarkdownContent.astro',
      },
      plugins: [
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
            // Declarations are fenced `ts signature`: not code to paste.
            plugin: [typedocSignatures],
          },
        }),
      ],
      head: [...(indexed ? [] : [{ tag: 'meta', attrs: { name: 'robots', content: 'noindex' } }])],
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
        { label: 'Sites', items: [{ autogenerate: { directory: 'sites' } }] },
        { label: 'Concepts', items: [{ autogenerate: { directory: 'concepts' } }] },
        {
          label: 'Deploy',
          // Kindgi Cloud's pages keep their hosted/ URLs: the platform links to them.
          // The pages for both sit at deploy/ itself.
          items: [
            'deploy',
            'deploy/retention',
            'deploy/authorization',
            'deploy/people-and-keys',
            { label: 'Kindgi Cloud', items: [{ autogenerate: { directory: 'hosted' } }] },
            {
              label: 'Self-hosted',
              items: [{ autogenerate: { directory: 'deploy/self-hosted' } }],
            },
          ],
        },
        // Newest first: each release adds its page's line.
        {
          label: 'Release notes',
          items: [
            { label: 'Overview', link: '/releases/' },
            { label: '0.1.9', link: '/releases/0.1.9/' },
            { label: '0.1.8', link: '/releases/0.1.8/' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Overview', link: '/reference/' },
            { label: 'Features by SDK', link: '/reference/sdks/' },
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
            { label: 'Error codes', link: '/reference/errors/' },
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
