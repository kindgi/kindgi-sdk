// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  agentMarkdown,
  markdownLink,
  pageToMarkdown,
  sidebarLinks,
  twinPath,
} from './agent-markdown.mjs';

const origin = 'https://docs.kindgi.com';
const siteDescription = 'The site.';

/** A built page as Starlight writes one: a title, a description and its content. */
function page({ title, description = siteDescription, content, head = '', sidebar = '' }) {
  return `<!doctype html><html><head><title>${title} | Kindgi</title><meta name="description" content="${description}">${head}</head><body>${sidebar}<main><h1 id="_top">${title}</h1><div class="sl-markdown-content">${content}</div></main></body></html>`;
}

const SIDEBAR = `<nav id="starlight__sidebar"><ul class="top-level">
<li><details open><summary><span class="group-label"><span>Start</span></span></summary><ul>
<li><a href="/start/install/">Install</a></li>
<li><a href="/start/quickstart/">Quickstart</a></li>
</ul></details></li>
<li><details><summary><span class="group-label"><span>Guides</span></span></summary><ul>
<li><details><summary><span class="group-label"><span>Tools</span></span></summary><ul>
<li><a href="/guides/tools/write-a-tool/">Write a tool</a></li>
</ul></details></li>
</ul></details></li>
<li><details><summary><span class="group-label"><span>Reference</span></span></summary><ul>
<li><a href="/reference/api/">HTTP API</a></li>
</ul></details></li>
</ul></nav>`;

const pages = new Set([
  '/',
  '/start/install/',
  '/start/quickstart/',
  '/guides/tools/write-a-tool/',
]);

function convert(content, extra = {}) {
  return pageToMarkdown(page({ title: 'Quickstart', content, ...extra }), {
    pageUrl: `${origin}/start/quickstart/`,
    pages,
    base: '/',
    siteDescription,
  });
}

test("a page's Markdown sits beside it, and the home page's in it", () => {
  assert.equal(twinPath('/start/install/', '/'), '/start/install.md');
  assert.equal(twinPath('/', '/'), '/index.md');
  assert.equal(twinPath('/v0.1.7/', '/v0.1.7/'), '/v0.1.7/index.md');
  assert.equal(twinPath('/v0.1.7/start/install/', '/v0.1.7/'), '/v0.1.7/start/install.md');
});

test('links become absolute, and a link to another page points at its Markdown', () => {
  const at = { pageUrl: `${origin}/start/quickstart/`, pages, base: '/' };
  assert.equal(markdownLink('../install/', at), `${origin}/start/install.md`);
  assert.equal(markdownLink('../install/#access', at), `${origin}/start/install.md#access`);
  assert.equal(markdownLink('#step-2', at), `${origin}/start/quickstart.md#step-2`);
  assert.equal(markdownLink('../../llms.txt', at), `${origin}/llms.txt`);
  assert.equal(
    markdownLink('https://github.com/kindgi/kindgi-sdk', at),
    'https://github.com/kindgi/kindgi-sdk',
  );
  assert.equal(markdownLink('mailto:contact@kindgi.com', at), 'mailto:contact@kindgi.com');
});

test('a page becomes its title, its own description and its content', () => {
  const md = convert('<p>Read <a href="../install/">Install</a> first.</p>', {
    description: 'Run a pack.',
  });
  assert.equal(md.title, 'Quickstart');
  assert.equal(md.description, 'Run a pack.');
  assert.equal(
    md.markdown,
    `# Quickstart\n\n> Run a pack.\n\nRead [Install](${origin}/start/install.md) first.\n`,
  );
});

test("the site's own description isn't repeated on a page without one", () => {
  const md = convert('<p>Hi.</p>');
  assert.equal(md.description, undefined);
  assert.equal(md.markdown, '# Quickstart\n\nHi.\n');
});

test('headings lose their anchor links', () => {
  const md = convert(
    '<div class="sl-heading-wrapper level-h2"><h2 id="run-it">Run it</h2><a class="sl-anchor-link" href="#run-it"><span aria-hidden="true">§</span><span class="sr-only">Section titled “Run it”</span></a></div>',
  );
  assert.match(md.markdown, /\n## Run it\n$/);
});

test('a note keeps its box: a quote that starts with its kind and title', () => {
  const md = convert(
    '<aside aria-label="Before you commit" class="starlight-aside starlight-aside--caution"><p class="starlight-aside__title" aria-hidden="true"><svg></svg>Before you commit</p><div class="starlight-aside__content"><p>Check <code>.gitignore</code>.</p></div></aside><aside aria-label="Tip" class="starlight-aside starlight-aside--tip"><p class="starlight-aside__title" aria-hidden="true">Tip</p><div class="starlight-aside__content"><p>Short.</p></div></aside>',
  );
  assert.match(md.markdown, /> \*\*Caution: Before you commit\*\*\n>\n> Check `\.gitignore`\./);
  assert.match(md.markdown, /> \*\*Tip\*\*\n>\n> Short\./);
});

const codeFrame = (title, language, lines) =>
  `<div class="expressive-code"><link rel="stylesheet" href="/_astro/ec.css"><script type="module" src="/_astro/ec.js"></script><figure class="frame"><figcaption class="header"><span class="title">${title}</span><span class="sr-only">Terminal window</span></figcaption><pre data-language="${language}"><code>${lines
    .map(
      (line) =>
        `<div class="ec-line"><div class="code">${line === '' ? '\n' : `<span>${line}</span>`}</div></div>`,
    )
    .join(
      '',
    )}</code></pre><div class="copy"><button title="Copy to clipboard" data-code="x"></button></div></figure></div>`;

test('code keeps its language, its file name and its empty lines, without the copy button', () => {
  const md = convert(
    codeFrame('tools/echo/index.ts', 'ts', ['const a = 1;', '', 'export default a;']),
  );
  assert.match(
    md.markdown,
    /`tools\/echo\/index\.ts`\n\n```ts\nconst a = 1;\n\nexport default a;\n```/,
  );
  assert.doesNotMatch(md.markdown, /Terminal window|Copy to clipboard/);
});

test('a terminal block has no file name', () => {
  const md = convert(codeFrame('', 'sh', ['pnpm install']));
  assert.equal(md.markdown, '# Quickstart\n\n```sh\npnpm install\n```\n');
});

test('tabs keep their labels, the hidden panels included', () => {
  const md = convert(
    '<starlight-tabs><div class="tablist-wrapper not-content"><ul role="tablist"><li role="presentation"><a role="tab" href="#tab-panel-0" aria-selected="true">TypeScript</a></li><li role="presentation"><a role="tab" href="#tab-panel-1">Python</a></li></ul></div><div id="tab-panel-0" role="tabpanel"><p>Use pnpm.</p></div><div id="tab-panel-1" role="tabpanel" hidden><p>Use uv.</p></div></starlight-tabs>',
  );
  assert.match(
    md.markdown,
    /- \*\*TypeScript\*\*\n\n {2}Use pnpm\.\n\n- \*\*Python\*\*\n\n {2}Use uv\./,
  );
});

test("what a reader can't see stays out: samples not picked, popovers and form controls", () => {
  const md = convert(
    '<div><select><option>cURL</option></select><div class="sl-openapi-snippet" data-openapi-snippet-id="javascript:fetch" hidden><p>fetch</p></div><div class="sl-openapi-snippet" data-openapi-snippet-id="shell:curl"><p>curl</p></div><div popover><p>urls</p></div></div>',
  );
  assert.equal(md.markdown, '# Quickstart\n\ncurl\n');
});

test('a redirect or a page with no content gets no Markdown', () => {
  const at = { pageUrl: `${origin}/old/`, pages, base: '/', siteDescription };
  assert.equal(
    pageToMarkdown(
      '<html><head><meta http-equiv="refresh" content="0;url=/new/"></head><body></body></html>',
      at,
    ),
    undefined,
  );
  assert.equal(
    pageToMarkdown('<html><body><main><h1>404</h1></main></body></html>', at),
    undefined,
  );
});

test('the sidebar gives each link in order, with the groups it sits in', () => {
  assert.deepEqual(sidebarLinks(`<html><body>${SIDEBAR}</body></html>`), [
    { href: '/start/install/', label: 'Install', groups: ['Start'] },
    { href: '/start/quickstart/', label: 'Quickstart', groups: ['Start'] },
    { href: '/guides/tools/write-a-tool/', label: 'Write a tool', groups: ['Guides', 'Tools'] },
    { href: '/reference/api/', label: 'HTTP API', groups: ['Reference'] },
  ]);
});

/** A built site in a temporary folder, from `{ path: html }`. */
function build(files) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-markdown-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function done(base, dir) {
  agentMarkdown({
    site: origin,
    base,
    title: 'Kindgi',
    description: siteDescription,
    details: 'Details.',
  }).hooks['astro:build:done']({
    dir: pathToFileURL(`${dir}/`),
    logger: { info: () => undefined },
  });
}

test('a build gets every Markdown page, llms.txt by section, and the files it lists', () => {
  const dir = build({
    'index.html': page({
      title: 'Kindgi documentation',
      description: 'Home.',
      content: '<p>Welcome.</p>',
    }),
    'start/install/index.html': page({
      title: 'Install',
      description: 'Get it.',
      content: '<p>Install it.</p>',
      sidebar: SIDEBAR,
    }),
    'start/quickstart/index.html': page({
      title: 'Quickstart',
      content: '<p>Go.</p>',
      sidebar: SIDEBAR,
    }),
    'guides/tools/write-a-tool/index.html': page({
      title: 'Write a tool',
      content: '<p>A tool.</p>',
      sidebar: SIDEBAR,
    }),
    'reference/api/index.html': page({
      title: 'HTTP API',
      content: '<p>Routes.</p>',
      sidebar: SIDEBAR,
    }),
    '404.html': '<html><body>Not found</body></html>',
  });
  try {
    done('/', dir);
    assert.equal(
      readFileSync(join(dir, 'start/install.md'), 'utf8'),
      '# Install\n\n> Get it.\n\nInstall it.\n',
    );
    assert.ok(existsSync(join(dir, 'index.md')));
    assert.match(
      readFileSync(join(dir, 'start/install/index.html'), 'utf8'),
      /<link rel="alternate" type="text\/markdown" href="\/start\/install\.md"><\/head>/,
    );

    const llms = readFileSync(join(dir, 'llms.txt'), 'utf8');
    assert.match(llms, /^# Kindgi\n\n> The site\.\n\nDetails\.\n/);
    assert.match(
      llms,
      /## Start\n\n- \[Kindgi documentation\]\(https:\/\/docs\.kindgi\.com\/index\.md\): Home\.\n- \[Install\]\(https:\/\/docs\.kindgi\.com\/start\/install\.md\): Get it\.\n- \[Quickstart\]\(https:\/\/docs\.kindgi\.com\/start\/quickstart\.md\)\n/,
    );
    assert.match(llms, /## Guides\n\n### Tools\n\n- \[Write a tool\]/);
    assert.match(
      llms,
      /## Optional\n\n### HTTP API\n\n- \[HTTP API\]\(https:\/\/docs\.kindgi\.com\/reference\/api\.md\)\n$/,
    );

    const start = readFileSync(join(dir, '_llms-txt/start.txt'), 'utf8');
    assert.match(
      start,
      /^<SYSTEM>Start: install, quickstarts, existing apps<\/SYSTEM>\n\n# Install\n\nSource: https:\/\/docs\.kindgi\.com\/start\/install\/\n\n> Get it\.\n\nInstall it\./,
    );
    assert.match(readFileSync(join(dir, 'llms-full.txt'), 'utf8'), /# HTTP API\n\nSource:/);
    assert.doesNotMatch(readFileSync(join(dir, 'llms-small.txt'), 'utf8'), /# HTTP API/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a version's build links into its own base", () => {
  const dir = build({
    'index.html': page({ title: 'Kindgi documentation', content: '<p>Welcome.</p>' }),
    'start/install/index.html': page({
      title: 'Install',
      content: '<p><a href="../../">Home</a></p>',
    }),
  });
  try {
    done('/v0.1.7/', dir);
    assert.equal(
      readFileSync(join(dir, 'start/install.md'), 'utf8'),
      `# Install\n\n[Home](${origin}/v0.1.7/index.md)\n`,
    );
    assert.match(
      readFileSync(join(dir, 'llms.txt'), 'utf8'),
      /https:\/\/docs\.kindgi\.com\/v0\.1\.7\/start\/install\.md/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
