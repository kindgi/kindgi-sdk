// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi suggested-changes pull <id> [--pr]`. The pack is a real git
 * repository with a bare one as its remote. The `git` on the command's
 * PATH writes down each call it gets, then runs the real git; the `gh` on
 * it is a fake that writes down its call and answers as a test says.
 */

import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KindgiApiError } from '@kindgi/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { consoleLinkOf, nameText } from '../src/commands/suggested-changes-pull.js';
import { runCli } from '../src/main.js';
import { stubOutGitRepoVars } from './git-env.js';

const PROJECT = '0b5a2f1e-6c0d-4f4a-9a7e-3c2b1d0e9f8a';
const OTHER_PROJECT = '7d1c0b9a-8e7f-4d6c-b5a4-9382716a5b4c';
const BRANCH = 'kindgi/acme.tone-1.1.0';
const BACK = `You're on ${BRANCH}: \`git switch main\` goes back.\n`;
const PR_URL = 'https://github.com/acme/pack/pull/7';
/** Words a person wrote, which the pull request never says. */
const WHY = 'The customer said: call me back on Tuesday';

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

let home: string;
let cwd: string;
let remote: string;
let bin: string;
let gitLog: string;
let ghLog: string;

beforeEach(async () => {
  stubOutGitRepoVars();
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-pack-'));
  remote = await mkdtemp(join(tmpdir(), 'kindgi-cli-remote-'));
  bin = await mkdtemp(join(tmpdir(), 'kindgi-cli-bin-'));
  gitLog = join(bin, 'git.log');
  ghLog = join(bin, 'gh.log');
  // Each argument, then a unit separator; each call ends with a record separator.
  await tool(
    'git',
    `for a in "$@"; do printf '%s\\037' "$a" >> '${gitLog}'; done\nprintf '\\036' >> '${gitLog}'\nexec '${REAL_GIT}' "$@"`,
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of [home, cwd, remote, bin]) await rm(dir, { recursive: true, force: true });
});

/** A program on the command's PATH, written as a `/bin/sh` script. */
async function tool(name: string, script: string): Promise<void> {
  const file = join(bin, name);
  await writeFile(file, `#!/bin/sh\n${script}\n`);
  await chmod(file, 0o755);
}

/** A fake `gh` that writes down its call, then prints `stdout` and `stderr` and exits with `code`. */
async function fakeGh(answer: { stdout?: string; stderr?: string; code?: number }): Promise<void> {
  await tool(
    'gh',
    [
      `for a in "$@"; do printf '%s\\037' "$a" >> '${ghLog}'; done`,
      `printf '\\036' >> '${ghLog}'`,
      `printf '%s' '${answer.stdout ?? ''}'`,
      `printf '%s' '${answer.stderr ?? ''}' >&2`,
      `exit ${answer.code ?? 0}`,
    ].join('\n'),
  );
}

/** The calls a fake wrote down, each as its arguments. */
async function calls(log: string): Promise<string[][]> {
  let text: string;
  try {
    text = await readFile(log, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\u001e')
    .filter((l) => l !== '')
    .map((l) => l.split('\u001f').slice(0, -1));
}

/** The environment the command runs git and gh with: only this test's `bin` on PATH. */
function env(): Record<string, string> {
  return { PATH: bin, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
}

/** git in the pack, as the test's own setup (not written down). */
function inPack(...args: string[]): string {
  return execFileSync(REAL_GIT, args, { cwd, env: env(), encoding: 'utf8' });
}

const TONE = {
  id: 'acme.tone',
  version: '1.0.0',
  kind: 'prompt',
  description: 'How replies sound',
  content: { template: 'Be brief.' },
};

/** A pack with a prompt block at 1.0.0, committed on main, with the bare repository as origin. */
async function pack(opts: { git?: boolean } = {}): Promise<void> {
  await mkdir(join(cwd, 'blocks'), { recursive: true });
  await writeFile(join(cwd, 'blocks/tone.json'), `${JSON.stringify(TONE, null, 2)}\n`);
  await writeFile(join(cwd, 'notes.txt'), 'Notes.\n');
  if (opts.git === false) return;
  execFileSync(REAL_GIT, ['init', '-q', '--bare', remote], { env: env() });
  inPack('init', '-q');
  inPack('symbolic-ref', 'HEAD', 'refs/heads/main');
  inPack('config', 'user.name', 'Ann Developer');
  inPack('config', 'user.email', 'ann@example.com');
  inPack('add', '.');
  inPack('commit', '-q', '-m', 'The pack');
  inPack('remote', 'add', 'origin', remote);
}

const SUGGESTED = {
  id: 'sc-1',
  agentId: 'acme.desk',
  projectId: PROJECT,
  title: 'Call back: acme.tone 1.0.0 → 1.1.0',
  madeBy: { kind: 'improve-run', improveRunId: 'ir-1' },
  builtOn: { version: '1.4.0' },
  version: '1.5.0',
  changes: [
    {
      kind: 'block',
      blockId: 'acme.tone',
      from: '1.0.0',
      to: '1.1.0',
      before: { template: 'Be brief.' },
      after: { template: 'Be brief, and offer a call back.' },
    },
  ],
  why: WHY,
  fixes: ['c-1', 'c-2'],
  check: {
    status: 'done',
    testSetId: 'acme.judged',
    now: { testRunId: 'tr-1', passing: 23, of: 27 },
    with: { testRunId: 'tr-2', passing: 25, of: 27 },
  },
  status: 'ready',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
};

/** A stub client: the suggested change, its block versions (1.0.0 is the pack's), and corrections in these statuses. */
function client(
  over: Record<string, unknown> = {},
  statuses: Record<string, string> = { 'c-1': 'open', 'c-2': 'with-owner' },
  refuse: ReadonlySet<string> = new Set(),
) {
  const sdk: [string, ...unknown[]][] = [];
  return {
    sdk,
    client: {
      suggestedChanges: {
        get: async (id: string) => {
          sdk.push(['suggestedChanges.get', id]);
          return { ...SUGGESTED, ...over };
        },
      },
      blocks: {
        versions: {
          get: async (blockId: string, version: string) => {
            sdk.push(['blocks.versions.get', blockId, version]);
            return {
              content:
                version === TONE.version
                  ? TONE.content
                  : { template: 'Be brief, and offer a call back.' },
            };
          },
        },
      },
      corrections: {
        get: async (id: string) => {
          sdk.push(['corrections.get', id]);
          return { id, status: statuses[id] ?? 'open' };
        },
        change: async (id: string, input: unknown) => {
          sdk.push(['corrections.change', id, input]);
          if (refuse.has(id)) {
            throw new KindgiApiError({
              code: 'forbidden',
              message: 'Needs publish on acme.desk.',
            } as never);
          }
          return { id, status: 'being-fixed' };
        },
      },
    },
  };
}

async function pull(
  argv: readonly string[],
  stub: { client: Record<string, unknown> },
  more: Record<string, string> = {},
) {
  return runCli({
    argv: ['suggested-changes', 'pull', ...argv, '--url=https://kindgi.acme.test', '--token=t'],
    env: { ...env(), ...more },
    cwd,
    home,
    clientFactory: () => stub.client as never,
    buildConfigLoader: async () => ({ pack: { id: 'acme.app', version: '1.0.0' } }),
  });
}

async function toneFile(): Promise<{ version: string; content: unknown }> {
  return JSON.parse(await readFile(join(cwd, 'blocks/tone.json'), 'utf8'));
}

const BODY = [
  'From an Improve run. It fixes 2 corrections. Test set: 25 of 27, up from 23.',
  '',
  '`blocks/tone.json` goes from acme.tone v1.0.0 to v1.1.0.',
  '',
  `The suggested change, with its check: https://kindgi.acme.test/console/projects/${PROJECT}/agents/acme.desk/suggested-changes/sc-1`,
  '',
  'Made with `kindgi suggested-changes pull` by Ann Developer.',
].join('\n');

describe('kindgi suggested-changes pull', () => {
  test("without --pr, writes its block version into the pack's file, and runs no git", async () => {
    await pack({ git: false });
    const stub = client();
    const out = await pull(['sc-1'], stub);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      suggestedChangeId: 'sc-1',
      wrote: [{ blockId: 'acme.tone', from: '1.0.0', to: '1.1.0', file: 'blocks/tone.json' }],
    });
    expect(await toneFile()).toEqual({
      ...TONE,
      version: '1.1.0',
      content: { template: 'Be brief, and offer a call back.' },
    });
    expect(stub.sdk).toEqual([
      ['suggestedChanges.get', 'sc-1'],
      ['blocks.versions.get', 'acme.tone', '1.0.0'],
      ['blocks.versions.get', 'acme.tone', '1.1.0'],
    ]);
    expect(await calls(gitLog)).toEqual([]);
  });

  test('with --pr: a branch, a commit of the block file alone, a push, a pull request, and the open corrections being-fixed', async () => {
    await pack();
    // Staged, and not the block's: it stays out of the commit.
    await writeFile(join(cwd, 'notes.txt'), 'Notes, edited.\n');
    inPack('add', 'notes.txt');
    await fakeGh({ stdout: `${PR_URL}\n` });
    const stub = client();
    const out = await pull(['sc-1', '--pr'], stub);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).toBe(BACK);
    const commit = inPack('rev-parse', 'HEAD').trim();
    expect(JSON.parse(out.stdout)).toEqual({
      suggestedChangeId: 'sc-1',
      wrote: [{ blockId: 'acme.tone', from: '1.0.0', to: '1.1.0', file: 'blocks/tone.json' }],
      branch: BRANCH,
      base: 'main',
      commit,
      remote: 'origin',
      pullRequest: { opened: true, url: PR_URL },
      corrections: {
        beingFixed: ['c-1'],
        left: [{ correctionId: 'c-2', status: 'with-owner' }],
        failed: [],
      },
    });
    expect(inPack('symbolic-ref', '--short', 'HEAD').trim()).toBe(BRANCH);
    expect(inPack('show', '--name-only', '--format=%s%n%an', 'HEAD').trim().split('\n')).toEqual([
      'Kindgi: acme.tone v1.1.0, from a suggested change',
      'Ann Developer',
      '',
      'blocks/tone.json',
    ]);
    expect(inPack('diff', '--cached', '--name-only').trim()).toBe('notes.txt');
    expect(
      execFileSync(REAL_GIT, ['--git-dir', remote, 'rev-parse', `refs/heads/${BRANCH}`], {
        env: env(),
        encoding: 'utf8',
      }).trim(),
    ).toBe(commit);
    const git = await calls(gitLog);
    expect(git).toContainEqual(['remote', 'get-url', '--push', 'origin']);
    expect(git).toContainEqual([
      'ls-remote',
      '--exit-code',
      '--heads',
      remote,
      `refs/heads/${BRANCH}`,
    ]);
    expect(git).toContainEqual(['checkout', '-b', BRANCH]);
    expect(git).toContainEqual([
      'commit',
      '--message',
      'Kindgi: acme.tone v1.1.0, from a suggested change',
      '--',
      'blocks/tone.json',
    ]);
    expect(git).toContainEqual(['push', '--set-upstream', 'origin', BRANCH]);
    expect(await calls(ghLog)).toEqual([
      [
        'pr',
        'create',
        '--base',
        'main',
        '--head',
        BRANCH,
        '--title',
        'Kindgi: acme.tone v1.1.0, from a suggested change',
        '--body',
        BODY,
      ],
    ]);
    expect(BODY).not.toContain('call me back');
    expect(stub.sdk).toEqual([
      ['suggestedChanges.get', 'sc-1'],
      ['blocks.versions.get', 'acme.tone', '1.0.0'],
      ['blocks.versions.get', 'acme.tone', '1.1.0'],
      ['corrections.get', 'c-1'],
      ['corrections.change', 'c-1', { status: 'being-fixed', link: PR_URL }],
      ['corrections.get', 'c-2'],
    ]);
  });

  test('a prompt that keeps its template in a file: both files are checked and committed', async () => {
    await mkdir(join(cwd, 'blocks'), { recursive: true });
    await pack();
    await writeFile(join(cwd, 'blocks/tone.liquid'), 'Be brief.');
    await writeFile(
      join(cwd, 'blocks/tone.json'),
      `${JSON.stringify({ ...TONE, content: { templateFile: 'tone.liquid' } }, null, 2)}\n`,
    );
    inPack('add', '.');
    inPack('commit', '-q', '-m', 'The template in its own file');
    await fakeGh({ stdout: `${PR_URL}\n` });
    const out = await pull(['sc-1', '--pr'], client());
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout).wrote).toEqual([
      {
        blockId: 'acme.tone',
        from: '1.0.0',
        to: '1.1.0',
        file: 'blocks/tone.json',
        templateFile: 'blocks/tone.liquid',
      },
    ]);
    expect(inPack('show', '--name-only', '--format=', 'HEAD').trim().split('\n')).toEqual([
      'blocks/tone.json',
      'blocks/tone.liquid',
    ]);
    expect((await calls(ghLog))[0]?.at(-1)).toContain(
      '`blocks/tone.json` and its template `blocks/tone.liquid` go from acme.tone v1.0.0 to v1.1.0.',
    );
  });

  test("git's repository variables in the shell don't point --pr at another repository", async () => {
    await pack();
    const elsewhere = join(home, 'elsewhere');
    execFileSync(REAL_GIT, ['init', '-q', elsewhere], { env: env() });
    await fakeGh({ stdout: `${PR_URL}\n` });
    const out = await pull(['sc-1', '--pr'], client(), {
      GIT_DIR: join(elsewhere, '.git'),
      GIT_WORK_TREE: elsewhere,
      GIT_INDEX_FILE: join(elsewhere, '.git/index'),
    });
    expect(out.exitCode, out.stderr).toBe(0);
    const { commit } = JSON.parse(out.stdout);
    expect(inPack('rev-parse', 'HEAD').trim()).toBe(commit);
    expect(inPack('symbolic-ref', '--short', 'HEAD').trim()).toBe(BRANCH);
    expect(
      execFileSync(REAL_GIT, ['-C', elsewhere, 'branch', '--list'], {
        env: env(),
        encoding: 'utf8',
      }),
    ).toBe('');
  });

  test('a changed template file refuses --pr, and nothing is written', async () => {
    await pack();
    await writeFile(join(cwd, 'blocks/tone.liquid'), 'Be brief.');
    // Older than the 1.0.0 the suggested change is built on: only git sees the edit.
    await writeFile(
      join(cwd, 'blocks/tone.json'),
      `${JSON.stringify({ ...TONE, version: '0.9.0', content: { templateFile: 'tone.liquid' } }, null, 2)}\n`,
    );
    inPack('add', '.');
    inPack('commit', '-q', '-m', 'The template in its own file');
    await writeFile(join(cwd, 'blocks/tone.liquid'), 'Be brief, edited.');
    await fakeGh({ stdout: `${PR_URL}\n` });
    const out = await pull(['sc-1', '--pr'], client());
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      "These block files have changes that aren't committed: blocks/tone.liquid. Commit or undo them first: --pr commits only the new version.",
    );
    expect(await readFile(join(cwd, 'blocks/tone.liquid'), 'utf8')).toBe('Be brief, edited.');
    expect(inPack('symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
  });

  test('without gh: the branch is pushed, the URL that opens the pull request is printed, and no correction changes', async () => {
    await pack();
    // The remote reads as GitHub; pushes go to the bare repository.
    inPack('remote', 'set-url', 'origin', 'https://github.com/acme/pack.git');
    inPack('config', `url.${remote}.pushInsteadOf`, 'https://github.com/acme/pack.git');
    const stub = client();
    const out = await pull(['sc-1', '--pr'], stub);
    expect(out.exitCode, out.stderr).toBe(0);
    const openAt = 'https://github.com/acme/pack/compare/main...kindgi/acme.tone-1.1.0?expand=1';
    expect(JSON.parse(out.stdout)).toMatchObject({
      branch: BRANCH,
      pullRequest: { opened: false, openAt },
      stillOpen: ['c-1'],
    });
    expect(out.stderr).toBe(
      [
        `gh isn't installed, so no pull request was opened. ${BRANCH} is pushed: open the pull request at ${openAt}.`,
        'Then mark what it fixes:',
        "  kindgi corrections set c-1 --status=being-fixed --link=<the pull request's URL>",
        BACK,
      ].join('\n'),
    );
    expect(stub.sdk.filter(([name]) => name === 'corrections.change')).toEqual([]);
  });

  test('without gh, to a remote that is no web host: where to open it, in words', async () => {
    await pack();
    const out = await pull(['sc-1', '--pr'], client({}, { 'c-1': 'being-fixed', 'c-2': 'fixed' }));
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ pullRequest: { opened: false }, stillOpen: [] });
    expect(out.stderr).toBe(
      `gh isn't installed, so no pull request was opened. ${BRANCH} is pushed: open a pull request from ${BRANCH} into main on origin.\n${BACK}`,
    );
  });

  test('gh fails: what it said, where to open the pull request, and exit 1', async () => {
    await pack();
    await fakeGh({ stderr: 'HTTP 401: Bad credentials (https://api.github.com/graphql)', code: 1 });
    const stub = client();
    const out = await pull(['sc-1', '--pr'], stub);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      `gh couldn't open the pull request (HTTP 401: Bad credentials (https://api.github.com/graphql)). ${BRANCH} is pushed: open a pull request from ${BRANCH} into main on origin.`,
    );
    expect(stub.sdk.filter(([name]) => name === 'corrections.change')).toEqual([]);
  });

  test('a correction the runtime refuses to mark: the others are marked, its line is left to run, and exit 0', async () => {
    await pack();
    await fakeGh({ stdout: `${PR_URL}\n` });
    const stub = client({}, { 'c-1': 'open', 'c-2': 'open' }, new Set(['c-1']));
    const out = await pull(['sc-1', '--pr'], stub);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout).corrections).toEqual({
      beingFixed: ['c-2'],
      left: [],
      failed: [{ correctionId: 'c-1', error: 'Needs publish on acme.desk.' }],
    });
    expect(out.stderr).toBe(
      [
        "c-1 isn't marked being-fixed (Needs publish on acme.desk.). Run this once it can be:",
        `  kindgi corrections set c-1 --status=being-fixed --link=${PR_URL}`,
        BACK,
      ].join('\n'),
    );
  });

  test('the push fails: what git said, and the commit stays on the branch', async () => {
    await pack();
    await writeFile(
      join(remote, 'hooks/pre-receive'),
      '#!/bin/sh\necho "Pushes are closed." >&2\nexit 1\n',
    );
    await chmod(join(remote, 'hooks/pre-receive'), 0o755);
    await fakeGh({ stdout: `${PR_URL}\n` });
    const out = await pull(['sc-1', '--pr'], client());
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(`Couldn't push ${BRANCH} to origin: `);
    expect(out.stderr).toContain(
      `The commit is on ${BRANCH}: push it yourself (\`git push --set-upstream origin ${BRANCH}\`), then open the pull request.`,
    );
    expect(await calls(ghLog)).toEqual([]);
  });

  describe('a file edited at the version the suggested change is built on: refused with or without --pr, before any git', () => {
    test.each<[string, () => Promise<void>, string]>([
      [
        'the block file',
        async () => {
          await writeFile(
            join(cwd, 'blocks/tone.json'),
            `${JSON.stringify({ ...TONE, content: { template: 'Be brief, and kind.' } }, null, 2)}\n`,
          );
        },
        "blocks/tone.json holds acme.tone 1.0.0 with edits that aren't in the 1.0.0 the suggested change is built on: pulling it would drop them. Make the change again on what the pack holds, or undo the edits.",
      ],
      [
        'its template file',
        async () => {
          await writeFile(join(cwd, 'blocks/tone.liquid'), 'Be brief, and kind.');
          await writeFile(
            join(cwd, 'blocks/tone.json'),
            `${JSON.stringify({ ...TONE, content: { templateFile: 'tone.liquid' } }, null, 2)}\n`,
          );
        },
        "blocks/tone.json and its template blocks/tone.liquid hold acme.tone 1.0.0 with edits that aren't in the 1.0.0 the suggested change is built on: pulling it would drop them.",
      ],
    ])('%s', async (_name, edit, said) => {
      await pack();
      await edit();
      inPack('add', '.');
      inPack('commit', '-q', '-m', 'Edited at the same version');
      const before = await readFile(join(cwd, 'blocks/tone.json'), 'utf8');
      for (const argv of [['sc-1'], ['sc-1', '--pr']]) {
        const out = await pull(argv, client());
        expect(out.exitCode).toBe(1);
        expect(out.stderr).toContain(said);
        expect(await readFile(join(cwd, 'blocks/tone.json'), 'utf8')).toBe(before);
      }
      expect(inPack('status', '--porcelain')).toBe('');
      expect(inPack('branch', '--list', '--format=%(refname:short)').trim()).toBe('main');
      expect(await calls(gitLog)).toEqual([]);
    });
  });

  describe('--pr refuses before anything is written', () => {
    test.each<[string, () => Promise<void>, string]>([
      [
        'a pack outside git',
        async () => {
          await pack({ git: false });
        },
        "isn't in a git repository: --pr makes a branch and a commit there. Without --pr, it only writes the files.",
      ],
      [
        'no git on PATH',
        async () => {
          await pack({ git: false });
          await rm(join(bin, 'git'));
        },
        "--pr runs git, and there's no `git` on your PATH: install git, or pull without --pr to only write the files.",
      ],
      [
        'a block file with changes not committed',
        async () => {
          await pack();
          await writeFile(join(cwd, 'blocks/tone.json'), `${JSON.stringify(TONE)}\n`);
        },
        "These block files have changes that aren't committed: blocks/tone.json.",
      ],
      [
        "git that can't say what's committed",
        async () => {
          await pack();
          await tool('git', `case " $* " in *" status "*) exit 1;; esac\nexec '${REAL_GIT}' "$@"`);
        },
        "git couldn't say whether the pack's block files have changes that aren't committed: check that `git status` works in the pack, then run this again.",
      ],
      [
        'a detached HEAD',
        async () => {
          await pack();
          inPack('checkout', '-q', '--detach');
        },
        'HEAD is detached: check out the branch the pull request goes into, then run this again.',
      ],
      [
        'no git user.name',
        async () => {
          await pack();
          inPack('config', '--unset', 'user.name');
        },
        'git has no user.name: set yours (`git config user.name "<your name>"`). The commit and the pull request name you.',
      ],
      [
        'no remote',
        async () => {
          await pack();
          inPack('remote', 'remove', 'origin');
        },
        "The pack's git repository has no remote to push the branch to: add one (`git remote add origin <url>`).",
      ],
      [
        'several remotes, none origin',
        async () => {
          await pack();
          inPack('remote', 'rename', 'origin', 'upstream');
          inPack('remote', 'add', 'fork', remote);
        },
        "The pack's git repository has several remotes, and none is called origin (fork, upstream): --pr pushes to origin.",
      ],
      [
        'the branch on the remote already',
        async () => {
          await pack();
          inPack('push', '-q', 'origin', `main:refs/heads/${BRANCH}`);
        },
        `origin has a branch ${BRANCH} already: a pull request for this version may be open. To make it again, delete that branch on origin first.`,
      ],
      [
        'the branch there already',
        async () => {
          await pack();
          inPack('branch', BRANCH);
        },
        `The branch ${BRANCH} is there already: a pull request for this version may be open. To make it again, delete the branch first (\`git branch -d ${BRANCH}\`).`,
      ],
    ])('%s', async (_name, setUp, said) => {
      await setUp();
      const before = await readFile(join(cwd, 'blocks/tone.json'), 'utf8');
      await fakeGh({ stdout: `${PR_URL}\n` });
      const stub = client();
      const out = await pull(['sc-1', '--pr'], stub);
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(said);
      expect(await readFile(join(cwd, 'blocks/tone.json'), 'utf8')).toBe(before);
      expect(await calls(ghLog)).toEqual([]);
      expect(stub.sdk).toEqual([
        ['suggestedChanges.get', 'sc-1'],
        ['blocks.versions.get', 'acme.tone', '1.0.0'],
      ]);
    });
  });

  describe('refused for the suggested change, with or without --pr', () => {
    test.each<[string, Record<string, unknown>, string]>([
      [
        'still checking',
        { status: 'checking' },
        "sc-1 is still being checked: pull it once it's `ready` (`kindgi suggested-changes get sc-1` shows its check).",
      ],
      [
        'its check failed',
        { status: 'check-failed' },
        "sc-1's check failed, so how it does isn't known: check it again first (`kindgi suggested-changes check sc-1 --wait`).",
      ],
      ['withdrawn', { status: 'withdrawn' }, "sc-1 was withdrawn: there's nothing to pull."],
      [
        "a deploy's",
        { changes: [{ kind: 'code', deploymentId: 'd-1' }] },
        "sc-1 is a deploy's change: its code is in the deploy's image, not in a block, so there's nothing to write into the pack.",
      ],
      [
        'a version not newer than the file',
        { changes: [{ kind: 'block', blockId: 'acme.tone', from: '0.9.0', to: '1.0.0' }] },
        "blocks/tone.json holds acme.tone 1.0.0 now, not older than the suggested change's 1.0.0: there's nothing to pull.",
      ],
      [
        'a file newer than the version it is built on',
        { changes: [{ kind: 'block', blockId: 'acme.tone', from: '0.9.0', to: '1.1.0' }] },
        "blocks/tone.json holds acme.tone 1.0.0, newer than the 0.9.0 the suggested change is built on: pulling it would drop 1.0.0's edits. Make the change again on what the pack holds.",
      ],
      [
        'a block the pack has not',
        { changes: [{ kind: 'block', blockId: 'acme.weights', from: '1.0.0', to: '1.1.0' }] },
        "acme.weights isn't among the pack's blocks (blocks/**/*.json): run this in the pack that has it, or pass --path=<dir>.",
      ],
    ])('%s', async (_name, over, said) => {
      await pack({ git: false });
      for (const argv of [['sc-1'], ['sc-1', '--pr']]) {
        const out = await pull(argv, client(over));
        expect(out.exitCode).not.toBe(0);
        expect(out.stderr).toContain(said);
        expect((await toneFile()).version).toBe('1.0.0');
      }
    });

    test('--project: refused for another project', async () => {
      await pack({ git: false });
      const out = await pull(['sc-1', `--project=${OTHER_PROJECT}`], client());
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain(`sc-1 is for project ${PROJECT}, not ${OTHER_PROJECT}.`);
      expect((await toneFile()).version).toBe('1.0.0');
    });

    test('--project: its own project pulls', async () => {
      await pack({ git: false });
      const out = await pull(['sc-1', `--project=${PROJECT}`], client());
      expect(out.exitCode, out.stderr).toBe(0);
      expect((await toneFile()).version).toBe('1.1.0');
    });
  });

  test('a git user.name is plain text in the pull request: no link, mention or markdown', () => {
    expect(nameText('Ann [me](https://x.test) @acme #1 *bold*')).toBe(
      'Ann \\[me\\]\\(https\\:\u200b\\/\\/x\\.test\\) \\@\u200bacme \\#\u200b1 \\*bold\\*',
    );
    expect(nameText(`${'a'.repeat(100)}\nb`)).toBe(`${'a'.repeat(80)}…`);
  });

  test("the console link is the suggested change's project path under the runtime's console", () => {
    const link = consoleLinkOf('https://kindgi.acme.test/', {
      id: 'sc 1',
      agentId: 'acme.desk',
      projectId: 'p/1',
    });
    expect(link).toBe(
      'https://kindgi.acme.test/console/projects/p%2F1/agents/acme.desk/suggested-changes/sc%201',
    );
    const path = new URL(link ?? '').pathname.split('/');
    expect(path).toEqual([
      '',
      'console',
      'projects',
      'p%2F1',
      'agents',
      'acme.desk',
      'suggested-changes',
      'sc%201',
    ]);
    expect(
      consoleLinkOf('https://kindgi.acme.test', { id: 'sc-1', agentId: 'acme.desk' }),
    ).toBeUndefined();
  });
});
