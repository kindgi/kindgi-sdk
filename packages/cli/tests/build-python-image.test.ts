// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** A Python pack's image: its Containerfile, its build context, its pack root. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { resolvePackRoots } from '../src/build/pack-root.js';
import { POETRY_VERSION } from '../src/build/poetry-requirements.js';
import {
  DEFAULT_PYTHON_BASE_IMAGE_REF,
  DEFAULT_UV_IMAGE_REF,
  IMAGE_UV_VERSION,
  PACK_UV_REQUIRED_VERSION,
  collectPythonContextFiles,
  renderPythonContainerfile,
} from '../src/build/python-image.js';
import { satisfiesSpecifiers } from '../src/build/version-specifier.js';

let packDir: string;
beforeEach(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'kindgi-python-image-'));
});
afterEach(async () => {
  await rm(packDir, { recursive: true, force: true });
});

async function files(entries: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(entries)) {
    await mkdir(dirname(join(packDir, rel)), { recursive: true });
    await writeFile(join(packDir, rel), text, 'utf8');
  }
}

describe('the Python Containerfile', () => {
  const text = renderPythonContainerfile({
    baseImageRef: DEFAULT_PYTHON_BASE_IMAGE_REF,
    uvImageRef: DEFAULT_UV_IMAGE_REF,
    artifactVersion: '20261001.4',
    publishedAt: '1970-01-01T00:00:00.000Z',
    buildTarget: 'staging',
    installer: 'uv',
    systemPackages: [],
  });

  test('pins its images by digest', () => {
    expect(DEFAULT_PYTHON_BASE_IMAGE_REF).toMatch(
      /^python:3\.13-slim-bookworm@sha256:[0-9a-f]{64}$/,
    );
    expect(DEFAULT_UV_IMAGE_REF).toMatch(/^ghcr\.io\/astral-sh\/uv:[\d.]+@sha256:[0-9a-f]{64}$/);
    expect(text).toContain(`FROM ${DEFAULT_PYTHON_BASE_IMAGE_REF} AS base`);
    expect(text).toContain(`COPY --from=${DEFAULT_UV_IMAGE_REF} /uv /usr/local/bin/uv`);
  });

  test('installs from the lockfile, frozen; indexes with the pins; serves the pack', () => {
    expect(text).toContain('RUN uv sync --frozen --no-dev --no-editable');
    expect(text).toContain('ARG KINDGI_ARTIFACT_VERSION=20261001.4');
    expect(text).toContain('ARG KINDGI_PUBLISHED_AT=1970-01-01T00:00:00.000Z');
    expect(text).toContain('python -m kindgi.pack index');
    expect(text).toContain('--output /app/index.json');
    expect(text).toContain('COPY --from=indexer /app/index.json /app/index.json');
    expect(text).toContain(
      'ENTRYPOINT ["/app/.venv/bin/python", "-m", "kindgi.pack", "serve", "--index", "/app/index.json", "--module-root", "/app"]',
    );
    expect(text).toMatch(/USER 65532:65532/);
  });
});

describe('the Python Containerfile — Poetry and Debian packages', () => {
  const base = {
    baseImageRef: DEFAULT_PYTHON_BASE_IMAGE_REF,
    uvImageRef: DEFAULT_UV_IMAGE_REF,
    artifactVersion: '20261001.4',
    publishedAt: '1970-01-01T00:00:00.000Z',
    buildTarget: 'staging',
  };

  test('a Poetry pack: Poetry pinned by hash in its own environment, the lock into /app/.venv', () => {
    const text = renderPythonContainerfile({ ...base, installer: 'poetry', systemPackages: [] });
    expect(text).toContain(
      `# Poetry ${POETRY_VERSION} and its dependencies, each file pinned by hash.`,
    );
    expect(text).toContain('COPY <<"POETRY_REQUIREMENTS" /opt/poetry-requirements.txt');
    expect(text).toContain(`poetry==${POETRY_VERSION} \\\n    --hash=sha256:`);
    expect(text).toContain(
      'uv pip install --python /opt/poetry/bin/python --require-hashes -r /opt/poetry-requirements.txt',
    );
    expect(text).toContain('POETRY_VIRTUALENVS_IN_PROJECT=true');
    expect(text).toContain('RUN /opt/poetry/bin/poetry install --only main --no-root --compile');
    expect(text).not.toContain('uv sync');
    // The heredoc ends where it should: its delimiter alone on a line, once.
    expect(text.split('\n').filter((l) => l === 'POETRY_REQUIREMENTS')).toHaveLength(1);
    // The rest of the image is the uv one: indexer and final stages unchanged.
    const uv = renderPythonContainerfile({ ...base, installer: 'uv', systemPackages: [] });
    const tail = (s: string) => s.slice(s.indexOf('# --- stage: indexer ---'));
    expect(tail(text)).toBe(tail(uv));
  });

  test('declared Debian packages install in the base stage, one apt step', () => {
    const text = renderPythonContainerfile({
      ...base,
      installer: 'uv',
      systemPackages: ['libmagic1', 'tesseract-ocr'],
    });
    const baseStage = text.slice(0, text.indexOf('# --- stage: build'));
    expect(baseStage).toContain(
      'RUN apt-get update \\\n && apt-get install -y --no-install-recommends libmagic1 tesseract-ocr \\\n && rm -rf /var/lib/apt/lists/*',
    );
    expect(text.match(/apt-get install/g)).toHaveLength(1);
    expect(
      renderPythonContainerfile({ ...base, installer: 'uv', systemPackages: [] }),
    ).not.toContain('apt-get');
  });
});

describe("a Python pack's build context", () => {
  test('the pack root, minus virtualenvs, caches, build output and secrets', async () => {
    await files({
      'pyproject.toml': '[tool.kindgi.pack]\nid = "p"\nversion = "1.0.0"\n',
      'uv.lock': 'version = 1\n',
      'tools/ledger.py': 'x = 1\n',
      'tools/__pycache__/ledger.cpython-313.pyc': 'x',
      'lib/db.py': 'y = 2\n',
      'templates/receipt.txt': 'hi\n',
      'vendor/kindgi-0.1.0a1-py3-none-any.whl': 'wheel',
      '.venv/bin/python': '',
      '.env': 'SECRET=1\n',
      '.env.local': 'SECRET=2\n',
      'keys/deploy.pem': 'k',
      '.git/HEAD': 'ref',
      '.kindgi/dev/index.json': '{}',
      'dist/kindgi.tar.gz': 'x',
      'node_modules/x/index.js': '',
      'ledger.egg-info/PKG-INFO': '',
    });
    const context = await collectPythonContextFiles(packDir);
    expect(context).toEqual({
      kind: 'ok',
      files: [
        'lib/db.py',
        'pyproject.toml',
        'templates/receipt.txt',
        'tools/ledger.py',
        'uv.lock',
        'vendor/kindgi-0.1.0a1-py3-none-any.whl',
      ],
      installer: 'uv',
    });
  });

  test('without a lockfile there is nothing to install from', async () => {
    await files({ 'pyproject.toml': '[tool.kindgi.pack]\nid = "p"\nversion = "1.0.0"\n' });
    const context = await collectPythonContextFiles(packDir);
    expect(context.kind === 'error' && context.message).toMatch(
      /no uv\.lock or poetry\.lock\. Run `uv lock` there \(`poetry lock` in a Poetry app\)/,
    );
  });

  test('the installer follows the lockfile: poetry.lock → Poetry, uv.lock first when both', async () => {
    await files({
      'pyproject.toml':
        '[tool.poetry]\nname = "app"\n\n[tool.kindgi.pack]\nid = "p"\nversion = "1.0.0"\n',
      'poetry.lock': '# poetry\n',
      // A Poetry app's own uv range is not checked: uv doesn't install it.
    });
    expect(await collectPythonContextFiles(packDir)).toMatchObject({
      kind: 'ok',
      installer: 'poetry',
    });
    await files({ 'uv.lock': 'version = 1\n' });
    expect(await collectPythonContextFiles(packDir)).toMatchObject({ kind: 'ok', installer: 'uv' });
  });
});

describe('the uv a Python pack works with', () => {
  test("the image's uv is the tag of its pinned ref, and the packs' range includes it", () => {
    expect(DEFAULT_UV_IMAGE_REF).toContain(`/uv:${IMAGE_UV_VERSION}@sha256:`);
    expect(satisfiesSpecifiers(IMAGE_UV_VERSION, PACK_UV_REQUIRED_VERSION)).toBe(true);
  });

  test("a required-version that excludes the image's uv stops the build, with the fix", async () => {
    await files({
      'pyproject.toml':
        '[tool.kindgi.pack]\nid = "p"\nversion = "1.0.0"\n\n[tool.uv]\nrequired-version = ">=0.13"\n',
      'uv.lock': 'version = 1\n',
    });
    const context = await collectPythonContextFiles(packDir);
    expect(context.kind === 'error' && context.message).toContain(
      `excludes uv ${IMAGE_UV_VERSION}, which installs it in Kindgi's image`,
    );
  });

  test('one that includes it — or none — builds', async () => {
    await files({
      'pyproject.toml': `[tool.kindgi.pack]\nid = "p"\nversion = "1.0.0"\n\n[tool.uv]\nrequired-version = "${PACK_UV_REQUIRED_VERSION}"\n`,
      'uv.lock': 'version = 1\n',
    });
    expect((await collectPythonContextFiles(packDir)).kind).toBe('ok');
  });
});

describe("a Python pack's roots", () => {
  test('[tool.kindgi] in pyproject.toml: a standalone Python pack, no Node project needed', async () => {
    await files({ 'pyproject.toml': '[tool.kindgi.pack]\nid = "p"\nversion = "1.0.0"\n' });
    const roots = await resolvePackRoots({ cwd: packDir });
    expect(roots).toEqual({
      kind: 'ok',
      roots: { packDir, repoRoot: packDir, mode: 'standalone', language: 'python' },
    });
  });

  test('a pyproject.toml without the table is not a pack', async () => {
    await files({ 'pyproject.toml': '[project]\nname = "app"\n' });
    const roots = await resolvePackRoots({ cwd: packDir });
    expect(roots.kind === 'err' && roots.code).toBe('no-config');
  });
});
