#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The release's GitHub release: the SDK's version, on its
 * `@kindgi/sdk@<version>` tag (the npm job pushes it), with the WordPress
 * plugin's zip and its checksum (`wordpress-plugin-zip.mjs`) attached. A
 * release candidate's is a pre-release, and never the latest.
 *
 * Run again for a version that has one, it updates it: the title, the
 * notes, and the files, replaced.
 *
 * Usage: `node scripts/github-release.mjs <plugin zip>`, with `gh` on the
 * path and GH_TOKEN set; `--notes <plugin zip>` prints the notes only (the
 * release job's summary shows them, a dry run's too).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLUGIN_DIR, pluginHeader, pluginVersion } from './wordpress-plugin-zip.mjs';

const NAME = 'github-release';

/** The tag the release goes on: the one `changeset git-tag` gives @kindgi/sdk. */
export function releaseTag(version) {
  return `@kindgi/sdk@${version}`;
}

/** The docs for a version: its release line's (`/v0.1/` for 0.1.x). */
export function docsBase(version) {
  const [major, minor] = version.split('.');
  return `https://docs.kindgi.com/v${major}.${minor}`;
}

/**
 * The release's notes. `plugin` is the WordPress plugin's version and what
 * it needs (its header's `Requires at least:` and `Requires PHP:`).
 */
export function releaseNotes({ version, plugin }) {
  const zip = `kindgi-${plugin.version}.zip`;
  return [
    `The Kindgi SDK ${version}. Its packages are on npm (\`@kindgi/*\`), PyPI (\`kindgi\`, \`kindgi-cli\`) and Maven Central, each at ${version}. Each package's \`CHANGELOG.md\` says what changed.`,
    '',
    `## The WordPress plugin ${plugin.version}`,
    '',
    `\`${zip}\` is the Kindgi plugin for WordPress: a Kindgi page in wp-admin, where a site's staff ask a project's agents and decide its approvals, each as themselves.`,
    '',
    `- **Check the download:** \`sha256sum -c ${zip}.sha256\`, or on macOS \`shasum -a 256 -c ${zip}.sha256\`.`,
    `- **Install it** under **Plugins → Add Plugin → Upload Plugin** (**Add New Plugin** before WordPress 6.8), then activate it. It needs WordPress ${plugin.wordpress} or later and PHP ${plugin.php} or later.`,
    `- **Connect it** as the guide says: ${docsBase(version)}/sites/wordpress/`,
    '',
  ].join('\n');
}

/**
 * The `gh` calls that make the release (`exists`: false) or update it, for
 * `files`, with the notes in `notesFile`.
 */
export function ghCalls({ version, exists, files, notesFile }) {
  const tag = releaseTag(version);
  const title = `Kindgi SDK ${version}`;
  const prerelease = version.includes('-');
  const latest = prerelease ? ['--prerelease', '--latest=false'] : ['--latest'];
  if (!exists) {
    return [
      [
        'release',
        'create',
        tag,
        ...files,
        '--verify-tag',
        '--title',
        title,
        '--notes-file',
        notesFile,
        ...latest,
      ],
    ];
  }
  return [
    [
      'release',
      'edit',
      tag,
      '--title',
      title,
      '--notes-file',
      notesFile,
      ...(prerelease ? latest : ['--prerelease=false', ...latest]),
    ],
    ['release', 'upload', tag, ...files, '--clobber'],
  ];
}

function main(args) {
  const notesOnly = args[0] === '--notes';
  const rest = notesOnly ? args.slice(1) : args;
  if (rest.length !== 1 || rest[0].startsWith('-')) {
    throw new Error('usage: node scripts/github-release.mjs [--notes] <plugin zip>');
  }
  const zip = rest[0];
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const { version } = JSON.parse(readFileSync(join(root, 'packages/sdk/package.json'), 'utf8'));
  const php = readFileSync(join(root, PLUGIN_DIR, 'kindgi.php'), 'utf8');
  const plugin = {
    version: pluginVersion(php),
    wordpress: pluginHeader(php, 'Requires at least'),
    php: pluginHeader(php, 'Requires PHP'),
  };
  if (basename(zip) !== `kindgi-${plugin.version}.zip`) {
    throw new Error(`${zip} isn't the plugin's zip at ${plugin.version}`);
  }
  const notes = releaseNotes({ version, plugin });
  if (notesOnly) {
    process.stdout.write(notes);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'kindgi-release-'));
  let exists = true;
  try {
    const notesFile = join(dir, 'notes.txt');
    writeFileSync(notesFile, notes);
    try {
      execFileSync('gh', ['release', 'view', releaseTag(version), '--json', 'tagName'], {
        stdio: 'ignore',
      });
    } catch {
      exists = false;
    }
    for (const call of ghCalls({ version, exists, files: [zip, `${zip}.sha256`], notesFile })) {
      execFileSync('gh', call, { stdio: 'inherit' });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`${exists ? 'Updated' : 'Made'} the GitHub release ${releaseTag(version)}`);
}

// Run as a program, not imported (by its tests).
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`${NAME}: ${err.message}`);
    process.exit(1);
  }
}
