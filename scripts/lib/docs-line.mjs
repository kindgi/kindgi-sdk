// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Which docs.kindgi.com links follow the release line, shared by the check
 * (scripts/check-refs.mjs, rule 4) and the script that moves them
 * (scripts/sync-docs-line.mjs), so the two read the same files.
 */

import { basename } from 'node:path';

/** A link to docs.kindgi.com, up to the first character that ends a URL in prose or code. */
export const DOCS_URL = /https:\/\/docs\.kindgi\.com\/[^\s)>`'"]*/g;
/** A link's release line part: `https://docs.kindgi.com/v<major>.<minor>/`. */
export const LINE_LINK = /https:\/\/docs\.kindgi\.com\/v\d+\.\d+\//g;
/** What a package or SDK ships from its `src/`, any file type, its tests aside. */
const SHIPPED = /^(?:packages\/[\w-]+|sdks\/(?:[\w-]+\/)*?[\w-]+)\/src\/(?!test\/)(?!.*\.test\.)/;

/** The docs line of a version: `https://docs.kindgi.com/v<major>.<minor>/`. */
export const docsLineOf = (version) =>
  `https://docs.kindgi.com/v${version.split('.').slice(0, 2).join('.')}/`;

/** A file beside a shipped skill's `SKILL.md`: `packages/sdk/skills/<name>/<file>` in markdown. */
const SKILL_FOLDER_FILE = /^packages\/sdk\/skills\/[\w-]+\/[\w.-]+\.md$/;

/**
 * Whether a skill's file, any `SKILL.md` or a markdown file beside a shipped
 * skill's: its links name the release line's docs.
 */
export const isSkill = (file) => basename(file) === 'SKILL.md' || SKILL_FOLDER_FILE.test(file);

/** Whether a package or SDK ships the file from its `src/` (a test doesn't). */
export const isShipped = (file) => SHIPPED.test(file);

/** Whether rule 4 reads the file's docs.kindgi.com links (a tracked, repository-relative path). */
export const followsDocsLine = (file) => isSkill(file) || isShipped(file);
