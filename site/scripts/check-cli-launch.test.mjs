// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bareLaunches, blockLaunches, launchesIn } from './check-cli-launch.mjs';

const runs = (line) => launchesIn(line).map((at) => line.slice(at, at + 10));
const page = (lang, ...body) => ['# A page', '', `\`\`\`${lang}`, ...body, '```', ''].join('\n');

test('a bare `kindgi` that starts a command is run', () => {
  for (const line of [
    'kindgi dev',
    '  kindgi deploy --env=prod',
    'cd acme && kindgi dev',
    'kindgi build || kindgi doctor',
    'true; kindgi runs list',
    'cat run.json | kindgi runs start --input -',
    '(cd pack && kindgi build)',
    'KINDGI_API_URL=https://platform.example.com kindgi auth whoami',
    'A=1 B="two words" kindgi dev',
    'nohup kindgi dev > .kindgi/dev.log 2>&1 &',
    'sudo env kindgi doctor',
    'if kindgi doctor; then kindgi dev; fi',
  ]) {
    assert.ok(launchesIn(line).length > 0, line);
  }
  assert.deepEqual(runs('kindgi build || kindgi doctor'), ['kindgi bui', 'kindgi doc']);
});

test('`$(…)` and backticks run what they hold, in quotes too', () => {
  assert.deepEqual(runs('TOKEN=$(kindgi auth token)'), ['kindgi aut']);
  assert.deepEqual(runs('echo "key: $(kindgi key create --json)"'), ['kindgi key']);
  assert.deepEqual(runs('echo `kindgi version`'), ['kindgi ver']);
  assert.deepEqual(runs('--out=erasures-$(date +%F).json'), []);
});

test('a `kindgi` that is an argument, quoted, or in a comment is not run', () => {
  for (const line of [
    'which kindgi',
    'ls node_modules/.bin/kindgi',
    'echo "kindgi dev"',
    "echo 'run kindgi dev; then kindgi deploy'",
    '# kindgi dev starts the runtime',
    'pnpm exec kindgi dev',
    'uv run kindgi dev',
    './kindgiw dev',
    'npx --yes @kindgi/cli@0.1 init acme',
    'uvx --from kindgi-cli kindgi init acme',
    'pnpm exec kindgi dev # or kindgi dev',
    'kindgi-index --help',
  ]) {
    assert.deepEqual(launchesIn(line), [], line);
  }
});

test('a continued line goes on in the next one; a heredoc is text', () => {
  assert.deepEqual(
    blockLaunches(['pnpm exec kindgi deploy \\', '  --env=prod \\', '  && kindgi doctor']),
    [{ line: 2, column: 5 }],
  );
  assert.deepEqual(blockLaunches(['echo start \\', 'kindgi dev']), []);
  assert.deepEqual(blockLaunches(['cat > notes.txt <<EOF', 'kindgi dev', 'EOF', 'kindgi doctor']), [
    { line: 3, column: 0 },
  ]);
  assert.deepEqual(blockLaunches(['cat <<-"END"', '  kindgi dev', '  END', 'kindgi build']), [
    { line: 3, column: 0 },
  ]);
});

test('only shell blocks are read, with their lines numbered in the page', () => {
  assert.deepEqual(bareLaunches(page('sh', 'pnpm install', 'kindgi dev')), [
    { line: 5, text: 'kindgi dev' },
  ]);
  for (const lang of ['bash', 'shell', 'zsh']) {
    assert.equal(bareLaunches(page(lang, 'kindgi dev')).length, 1, lang);
  }
  for (const lang of ['text', 'json', 'ts', 'python', '']) {
    assert.deepEqual(bareLaunches(page(lang, 'kindgi dev')), [], lang);
  }
  assert.deepEqual(bareLaunches(page('sh title="Run it"', 'kindgi dev')), [
    { line: 4, text: 'kindgi dev' },
  ]);
});

test('a fence inside a list, and a longer fence holding a shorter one', () => {
  const source = [
    '1. Start it:',
    '',
    '   ```sh',
    '   kindgi dev',
    '   ```',
    '',
    '````md',
    '```sh',
    'kindgi dev',
    '```',
    '````',
  ].join('\n');
  assert.deepEqual(bareLaunches(source), [{ line: 4, text: 'kindgi dev' }]);
});

test('a page that starts the CLI from the registry passes; a bare `kindgi` fails', () => {
  const before = page(
    'sh',
    'npx --yes @kindgi/cli@0.1 doctor --json',
    'uvx --from "kindgi-cli>=0.1,<0.2" kindgi init my-agents --template=python',
    '<read the clipboard> | npx --yes @kindgi/cli@0.1 auth registry --password-stdin',
  );
  assert.deepEqual(bareLaunches(before), []);
  // A comment on the page doesn't take it out of the check.
  const bare = `<!-- cli-launch: the rule above maps it -->\n${page('sh', 'kindgi doctor --json')}`;
  assert.deepEqual(bareLaunches(bare), [{ line: 5, text: 'kindgi doctor --json' }]);
});
