// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The image of a Python pack (`[tool.kindgi]` in `pyproject.toml`).
 *
 * Its dependencies install from the pack's own lockfile, frozen (the K6
 * rule): `uv.lock` with `uv sync --frozen`, or `poetry.lock` with Poetry
 * (pinned with all its dependencies by hash, `poetry-requirements.ts`) —
 * both into `/app/.venv`. Debian packages the pack declares
 * (`[tool.kindgi.image] system-packages`, `apt.ts`) install in the base
 * stage, so the build and the running image both have them. An indexer
 * stage writes `/app/index.json` with
 * `python -m kindgi.pack index` and the pinned artifact version and
 * publish time — byte-identical to the CLI's local index, so the
 * integrity gate holds; the image runs the pack service,
 * `python -m kindgi.pack serve`, on `PORT` (8080).
 *
 * The build context is the pack root as it is — Python code imports the
 * application beside it, so there is no closure to compute — minus what
 * never belongs in an image: virtualenvs, caches, build output, `.git`,
 * `.kindgi`, `node_modules`, and secret-shaped files (`.env*`, keys).
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { parse } from 'smol-toml';

import { renderAptGetStep } from './apt.js';
import { forbiddenReason } from './context-files.js';
import { POETRY_REQUIREMENTS, POETRY_VERSION } from './poetry-requirements.js';
import { satisfiesSpecifiers } from './version-specifier.js';

/** `python:3.13-slim-bookworm`, pinned (manifest list digest, verified 2026-10-01). */
export const DEFAULT_PYTHON_BASE_IMAGE_REF =
  'python:3.13-slim-bookworm@sha256:2325bb286ec344af3e5898cc224b5844e2707ac6e26b1632516fd3edc84a5e26';

/** `ghcr.io/astral-sh/uv:0.12.15`, pinned (manifest list digest, verified 2026-10-01). */
export const DEFAULT_UV_IMAGE_REF =
  'ghcr.io/astral-sh/uv:0.12.15@sha256:62f8c047d0a0e9ece6b53fc63df902585a67a47a7f318ddec4a37db586edc8e3';

/** The uv in the image — `DEFAULT_UV_IMAGE_REF`'s tag. */
export const IMAGE_UV_VERSION = '0.12.15';

/**
 * The uv versions a pack works with: the image's uv reads the `uv.lock`
 * they write. `kindgi init` sets it as a pack's `[tool.uv] required-version`
 * (an existing app keeps its own); the Kindgi SDK repository uses the same
 * range. Move it with `DEFAULT_UV_IMAGE_REF`.
 */
export const PACK_UV_REQUIRED_VERSION = '>=0.12.15,<0.13';

/** How a Python pack's dependencies install — by its lockfile. */
export type PythonInstaller = 'uv' | 'poetry';

/** The lockfile each installer reads, in the order they're looked for. */
export const PYTHON_LOCKFILES: Readonly<Record<PythonInstaller, string>> = {
  uv: 'uv.lock',
  poetry: 'poetry.lock',
};

/** A Python pack image's pack service: its ENTRYPOINT. */
export const PYTHON_PACK_SERVICE_COMMAND: readonly string[] = [
  '/app/.venv/bin/python',
  '-m',
  'kindgi.pack',
  'serve',
  '--index',
  '/app/index.json',
  '--module-root',
  '/app',
];

export interface RenderPythonContainerfileInputs {
  readonly baseImageRef: string;
  readonly uvImageRef: string;
  readonly artifactVersion: string;
  readonly publishedAt: string;
  readonly buildTarget: string;
  readonly installer: PythonInstaller;
  /** Debian packages for the base stage, checked (`checkAptPackages`). */
  readonly systemPackages: readonly string[];
}

export function renderPythonContainerfile(inputs: RenderPythonContainerfileInputs): string {
  const { baseImageRef, uvImageRef, artifactVersion, publishedAt, buildTarget } = inputs;
  const apt = renderAptGetStep(inputs.systemPackages);
  return `# syntax=docker/dockerfile:1
# A Python Kindgi pack. Emitted by \`kindgi build\` — do not hand-edit.
# Reproducibility: SOURCE_DATE_EPOCH=0 + KINDGI_BUILD_TARGET come from the
# build server; KINDGI_ARTIFACT_VERSION + KINDGI_PUBLISHED_AT are pinned here
# so this image's index.json matches the CLI's byte for byte.

# --- stage: base ---
FROM ${baseImageRef} AS base
ENV PYTHONDONTWRITEBYTECODE=1 \\
    PYTHONUNBUFFERED=1
WORKDIR /app
${apt === '' ? '' : `${apt}\n`}
# --- stage: build — the pack's dependencies, from its own lockfile ---
FROM base AS build
COPY --from=${uvImageRef} /uv /usr/local/bin/uv
${inputs.installer === 'poetry' ? poetryInstall() : uvInstall()}

# --- stage: indexer ---
FROM build AS indexer
ARG SOURCE_DATE_EPOCH=0
ARG KINDGI_BUILD_TARGET=${buildTarget}
ARG KINDGI_ARTIFACT_VERSION=${artifactVersion}
ARG KINDGI_PUBLISHED_AT=${publishedAt}
RUN /app/.venv/bin/python -m kindgi.pack index \\
      --pack-dir /app \\
      --artifact-version "\${KINDGI_ARTIFACT_VERSION}" \\
      --published-at "\${KINDGI_PUBLISHED_AT}" \\
      --output /app/index.json

# --- stage: final — the pack service ---
FROM base AS final
ARG KINDGI_ARTIFACT_VERSION=${artifactVersion}
ARG KINDGI_PUBLISHED_AT=${publishedAt}
ENV KINDGI_ARTIFACT_VERSION=\${KINDGI_ARTIFACT_VERSION} \\
    KINDGI_PUBLISHED_AT=\${KINDGI_PUBLISHED_AT} \\
    PATH=/app/.venv/bin:\${PATH} \\
    PORT=8080
COPY --from=build /app /app
COPY --from=indexer /app/index.json /app/index.json
USER 65532:65532
EXPOSE 8080
ENTRYPOINT [${PYTHON_PACK_SERVICE_COMMAND.map((arg) => JSON.stringify(arg)).join(', ')}]
CMD []
`;
}

function uvInstall(): string {
  return `ENV UV_COMPILE_BYTECODE=1 \\
    UV_LINK_MODE=copy \\
    UV_PYTHON_DOWNLOADS=never \\
    UV_PROJECT_ENVIRONMENT=/app/.venv
COPY . .
RUN uv sync --frozen --no-dev --no-editable`;
}

/**
 * Poetry (`POETRY_VERSION`) in an environment of its own, every file checked
 * against its hash; then the pack's main dependencies from `poetry.lock`
 * into `/app/.venv` (Poetry refuses a lock out of step with
 * `pyproject.toml`), the pack itself not installed — its files are run in
 * place, as with uv.
 */
function poetryInstall(): string {
  return `# Poetry ${POETRY_VERSION} and its dependencies, each file pinned by hash.
COPY <<"POETRY_REQUIREMENTS" /opt/poetry-requirements.txt
${POETRY_REQUIREMENTS.trimEnd()}
POETRY_REQUIREMENTS
ENV UV_PYTHON_DOWNLOADS=never
RUN uv venv /opt/poetry \\
 && uv pip install --python /opt/poetry/bin/python --require-hashes -r /opt/poetry-requirements.txt
ENV POETRY_VIRTUALENVS_IN_PROJECT=true \\
    POETRY_NO_INTERACTION=1
COPY . .
RUN /opt/poetry/bin/poetry install --only main --no-root --compile`;
}

/** Directories never shipped: virtualenvs, caches, build output. */
const SKIPPED_DIRS = new Set([
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  '.mypy_cache',
  '.tox',
  '.nox',
  'build',
  'dist',
]);

export type PythonContextFiles =
  | {
      readonly kind: 'ok';
      readonly files: readonly string[];
      /** By the lockfile the pack has: `uv.lock`, else `poetry.lock`. */
      readonly installer: PythonInstaller;
    }
  | { readonly kind: 'error'; readonly message: string };

/** The pack-relative files of a Python pack's build context, and how it installs. */
export async function collectPythonContextFiles(packDir: string): Promise<PythonContextFiles> {
  const files: string[] = [];
  async function walk(rel: string): Promise<void> {
    const entries = await readdir(rel === '' ? packDir : join(packDir, rel), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name) || entry.name.endsWith('.egg-info')) continue;
        if (forbiddenReason(`${child}/x`) !== undefined) continue;
        await walk(child);
      } else if (entry.isFile() && forbiddenReason(child) === undefined && !entry.name.endsWith('.pyc')) {
        files.push(child);
      }
    }
  }
  await walk('');
  if (!files.includes('pyproject.toml')) {
    return { kind: 'error', message: `No pyproject.toml at ${packDir}.` };
  }
  const installer = (Object.keys(PYTHON_LOCKFILES) as PythonInstaller[]).find((i) =>
    files.includes(PYTHON_LOCKFILES[i]),
  );
  if (installer === undefined) {
    return {
      kind: 'error',
      message: `A Python pack's image installs from its lockfile, and ${packDir} has no ${PYTHON_LOCKFILES.uv} or ${PYTHON_LOCKFILES.poetry}. Run \`uv lock\` there (\`poetry lock\` in a Poetry app); the dependencies must include kindgi.`,
    };
  }
  if (installer === 'uv') {
    const uv = await uvVersionProblem(join(packDir, 'pyproject.toml'));
    if (uv !== undefined) return { kind: 'error', message: uv };
  }
  return { kind: 'ok', files: files.sort(), installer };
}

/**
 * Why the image's uv would refuse the pack — its `[tool.uv]
 * required-version` excludes `IMAGE_UV_VERSION` — or `undefined`. Checked
 * here so the build stops before uploading, with the fix, instead of
 * `uv sync` failing inside the image.
 */
async function uvVersionProblem(pyprojectPath: string): Promise<string | undefined> {
  let required: unknown;
  try {
    const doc = parse(await readFile(pyprojectPath, 'utf8')) as {
      tool?: { uv?: Record<string, unknown> };
    };
    required = doc.tool?.uv?.['required-version'];
  } catch {
    return undefined; // the indexer reports an unreadable pyproject
  }
  if (typeof required !== 'string') return undefined;
  if (satisfiesSpecifiers(IMAGE_UV_VERSION, required) !== false) return undefined;
  return `The pack's [tool.uv] required-version ("${required}") excludes uv ${IMAGE_UV_VERSION}, which installs it in Kindgi's image — uv sync there would refuse. Use a range that includes it, e.g. "${PACK_UV_REQUIRED_VERSION}", and \`uv lock\` with a uv in it.`;
}
