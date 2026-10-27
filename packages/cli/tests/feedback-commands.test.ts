// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi feedback submit`, `status` and `withdraw`, as a person or a coding
 * agent runs them: a real pack with a real `FEEDBACK.md` (written by
 * `kindgi feedback write`), real keys under a temporary home, and a stand-in
 * for the intake that keeps to its wire contract. No `withdrawKey` ever
 * shows in any output.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

import type { DoctorReport } from '../src/commands/doctor.js';
import type { FeedbackSeam } from '../src/feedback/run.js';
import { runCli } from '../src/main.js';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const HOUR = 3_600_000;
const ORIGIN = 'https://access.kindgi.com';

const DOCTOR: DoctorReport = {
  ok: false,
  cliVersion: '0.1.8',
  project: { dir: '/Users/acme-dev/work/acme-pack', language: 'node' },
  consoleUrl: 'http://localhost:4100/console',
  checks: [
    { id: 'node', status: 'pass', message: 'Node 22.12.0' },
    {
      id: 'runtime',
      status: 'fail',
      message: 'Nothing answers at http://localhost:4000 for /Users/acme-dev/work/acme-pack',
      fix: 'kindgi dev',
      details: ['/Users/acme-dev/.kindgirc.json'],
    },
  ],
};

const PLATFORM = { os: 'darwin', osRelease: '25.4.0', arch: 'arm64', node: '22.12.0' };

/** Every output any command printed, to check no withdrawKey ever showed. */
const printed: string[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

interface Stored {
  readonly keyHash: string;
  state: string;
  fixedIn?: string;
  issueUrl?: string;
  reason?: string;
  withdrawn: boolean;
}

/** A stand-in for the intake: the three routes, as the wire contract has them. */
function intake() {
  const reports = new Map<string, Stored>();
  const requests: { path: string; body: string }[] = [];
  let answer: ((path: string, body: string) => Response | undefined) | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = String(init?.body ?? '');
    requests.push({ path, body });
    expect(String(url).startsWith(ORIGIN)).toBe(true);
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    const override = answer?.(path, body);
    if (override !== undefined) return override;
    const json = JSON.parse(body);
    if (path === '/feedback/reports') {
      const out = json.entries.map((e: { entry: string }) => {
        const reportId = `fbr_${randomBytes(12).toString('base64url')}`;
        const withdrawKey = `kgi_fw_${randomBytes(16).toString('base64url')}`;
        reports.set(reportId, {
          keyHash: sha256(withdrawKey),
          state: 'received',
          withdrawn: false,
        });
        return { entry: e.entry, reportId, withdrawKey };
      });
      return Response.json({ reports: out }, { status: 201 });
    }
    if (path === '/feedback/reports/status') {
      return Response.json({
        reports: json.reportIds.map((reportId: string) => {
          const r = reports.get(reportId);
          if (r === undefined) return { reportId, state: 'unknown' };
          if (r.withdrawn) return { reportId, state: 'withdrawn' };
          return {
            reportId,
            state: r.state,
            ...(r.issueUrl !== undefined && { issueUrl: r.issueUrl }),
            ...(r.fixedIn !== undefined && { fixedIn: r.fixedIn }),
            ...(r.reason !== undefined && { reason: r.reason }),
          };
        }),
      });
    }
    if (path === '/feedback/reports/withdraw') {
      const withdrawn: string[] = [];
      const refused: string[] = [];
      for (const { reportId, withdrawKey } of json.reports) {
        const r = reports.get(reportId);
        if (r === undefined || r.keyHash !== sha256(withdrawKey)) refused.push(reportId);
        else {
          r.withdrawn = true;
          withdrawn.push(reportId);
        }
      }
      return Response.json({ withdrawn, refused });
    }
    return Response.json({ error: 'not-found', message: 'no route' }, { status: 404 });
  }) as typeof fetch;
  return {
    fetchImpl,
    reports,
    requests,
    answerWith: (f: (path: string, body: string) => Response | undefined) => {
      answer = f;
    },
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A home with a pack in it, and a cli bound to both. */
async function setup(over: { seam?: FeedbackSeam; env?: Record<string, string> } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'acme-feedback-home-'));
  dirs.push(home);
  const pack = join(home, 'work', 'acme-pack');
  await mkdir(pack, { recursive: true });
  const service = intake();
  let now = NOW;
  const seam: FeedbackSeam = {
    now: () => now,
    doctor: async () => DOCTOR,
    platform: PLATFORM,
    interactive: () => false,
    ...over.seam,
  };
  const cli = async (argv: string[], extra: Record<string, unknown> = {}) => {
    const out = await runCli({
      argv,
      env: { HOME: home, ...over.env },
      home,
      cwd: pack,
      fetchImpl: service.fetchImpl,
      feedbackSeam: seam,
      ...extra,
    });
    printed.push(out.stdout, out.stderr);
    return out;
  };
  const write = async (title: string, body: string, kind = 'bug') => {
    const out = await cli([
      'feedback',
      'write',
      `--kind=${kind}`,
      `--title=${title}`,
      `--body=${body}`,
      '--authored-by=claude-code',
    ]);
    expect(out.exitCode).toBe(0);
    return JSON.parse(out.stdout).id as string;
  };
  const feedback = () => readFile(join(pack, 'FEEDBACK.md'), 'utf8');
  const keysFile = join(home, '.kindgi', 'feedback', 'keys.json');
  const keys = async () => JSON.parse(await readFile(keysFile, 'utf8')).reports;
  return {
    home,
    pack,
    service,
    cli,
    write,
    feedback,
    keys,
    keysFile,
    later: (ms: number) => {
      now += ms;
    },
  };
}

const json = (stdout: string) => JSON.parse(stdout);

describe('kindgi feedback submit', () => {
  test('--preview prints exactly what would be sent, redacted, with its digest, and sends nothing', async () => {
    const t = await setup();
    await writeFile(join(t.pack, '.env'), 'ACME_WEBHOOK=https://hooks.acme.test/in/abc123\n');
    const id = await t.write(
      'kindgi dev fails under /Users/acme-dev/clients',
      `It read ${t.pack}/src/tool.ts and ${t.home}/.config/acme.json, posted to https://hooks.acme.test/in/abc123, mail dev@acme.test`,
    );
    const before = await t.feedback();
    const out = await t.cli(['feedback', 'submit', '--preview']);
    expect(out.exitCode).toBe(0);
    expect(t.service.requests).toEqual([]);
    expect(await t.feedback()).toBe(before);

    const preview = json(out.stdout);
    expect(preview.to).toBe(`${ORIGIN}/feedback/reports`);
    expect(preview.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.digest).toBe(sha256(JSON.stringify(preview.payload)));
    const [entry] = preview.payload.entries;
    expect(entry).toMatchObject({
      entry: id,
      kind: 'bug',
      severity: 'medium',
      by: 'claude-code',
      title: 'kindgi dev fails under [path]',
    });
    expect(entry.body).toBe('It read ./src/tool.ts and [path], posted to [redacted], mail [email]');
    expect(preview.redacted).toEqual([{ entry: id, rules: ['env-values', 'emails', 'paths'] }]);
    expect(preview.payload.client).toEqual({
      cli: '0.1.8',
      ...PLATFORM,
      language: 'node',
      checks: [
        { id: 'node', status: 'pass' },
        { id: 'runtime', status: 'fail' },
      ],
    });
    // The doctor's text, the pack's folder and the console are never sent.
    expect(JSON.stringify(preview.payload)).not.toMatch(/acme-dev|localhost|kindgirc|acme-pack/);
    expect(out.stderr).toContain(`--yes=${preview.digest}`);
  });

  test('with no terminal and no --yes, nothing is sent', async () => {
    const t = await setup();
    await t.write('A bug', 'Body.');
    const out = await t.cli(['feedback', 'submit']);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('sends only what the person has seen');
    expect(t.service.requests).toEqual([]);
  });

  test("--yes with the preview's digest sends those bytes; FEEDBACK.md gets the report ids and keys.json the keys", async () => {
    const t = await setup();
    const one = await t.write('First bug', 'Body one.');
    const two = await t.write('Second bug', 'Body two.', 'friction');
    const { digest } = json((await t.cli(['feedback', 'submit', '--preview'])).stdout);
    const out = await t.cli(['feedback', 'submit', `--yes=${digest}`]);
    expect(out.exitCode).toBe(0);

    expect(t.service.requests).toHaveLength(1);
    expect(sha256(t.service.requests[0]?.body ?? '')).toBe(digest);
    const sent = json(out.stdout);
    expect(sent.reports.map((r: { entry: string }) => r.entry)).toEqual([one, two]);
    expect(sent.keys).toBe(t.keysFile);
    for (const r of sent.reports) {
      expect(r.reportId).toMatch(/^fbr_/);
      expect(Object.keys(r)).toEqual(['entry', 'reportId']);
    }

    const keys = await t.keys();
    expect(Object.keys(keys).sort()).toEqual(
      sent.reports.map((r: { reportId: string }) => r.reportId).sort(),
    );
    for (const k of Object.values(keys) as { withdrawKey: string; submittedAt: string }[]) {
      expect(k.withdrawKey).toMatch(/^kgi_fw_/);
      expect(k.submittedAt).toBe(new Date(NOW).toISOString());
    }
    expect((await stat(t.keysFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(t.home, '.kindgi', 'feedback'))).mode & 0o777).toBe(0o700);

    const file = await t.feedback();
    for (const r of sent.reports) {
      expect(file).toContain(
        `- **submitted:** ${new Date(NOW).toISOString()} · **report:** ${r.reportId}\n`,
      );
    }
    expect(file).not.toContain('kgi_fw_');

    // Sent once: a second run has nothing to send.
    const again = await t.cli(['feedback', 'submit', '--preview']);
    expect(json(again.stdout).reports).toEqual([]);
    expect(again.stderr).toContain('Nothing to send');
  });

  test('a stale digest sends nothing: the entry changed since the preview', async () => {
    const t = await setup();
    await t.write('A bug', 'Body.');
    const { digest } = json((await t.cli(['feedback', 'submit', '--preview'])).stdout);
    await writeFile(
      join(t.pack, 'FEEDBACK.md'),
      (await t.feedback()).replace('Body.', 'Body, edited.'),
    );
    const out = await t.cli(['feedback', 'submit', `--yes=${digest}`]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('changed since that preview');
    expect(t.service.requests).toEqual([]);
  });

  test('at a terminal it shows the report and asks; only a yes sends', async () => {
    const asked: string[] = [];
    const no = await setup({
      seam: {
        interactive: () => true,
        confirm: async (q) => {
          asked.push(q);
          return false;
        },
      },
    });
    await no.write('A bug', 'Body.');
    const refused = await no.cli(['feedback', 'submit']);
    expect(refused.exitCode).toBe(1);
    expect(no.service.requests).toEqual([]);
    expect(asked[0]).toContain(`Send this to Kindgi (${ORIGIN})?`);

    const yes = await setup({ seam: { interactive: () => true, confirm: async () => true } });
    await yes.write('A bug', 'Body.');
    expect((await yes.cli(['feedback', 'submit'])).exitCode).toBe(0);
    expect(yes.service.requests).toHaveLength(1);
  });

  test('KINDGI_FEEDBACK_SUBMIT=off sends nothing; any value but on or off sends nothing either', async () => {
    for (const value of ['off', 'OFF', 'false']) {
      const t = await setup({ env: { KINDGI_FEEDBACK_SUBMIT: value } });
      await t.write('A bug', 'Body.');
      const out = await t.cli(['feedback', 'submit', '--preview']);
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(
        value.toLowerCase() === 'off' ? 'Sending feedback is off here' : 'must be on or off',
      );
      expect(t.service.requests).toEqual([]);
    }
    const on = await setup({ env: { KINDGI_FEEDBACK_SUBMIT: 'on' } });
    await on.write('A bug', 'Body.');
    expect((await on.cli(['feedback', 'submit', '--preview'])).exitCode).toBe(0);
  });

  test('a named entry is sent again, as a new report beside the first', async () => {
    const t = await setup();
    const id = await t.write('A bug', 'Body.');
    const send = async () => {
      const { digest } = json((await t.cli(['feedback', 'submit', id, '--preview'])).stdout);
      return json((await t.cli(['feedback', 'submit', id, `--yes=${digest}`])).stdout);
    };
    const first = await send();
    const second = await send();
    expect(second.reports[0].reportId).not.toBe(first.reports[0].reportId);
    expect((await t.feedback()).match(/\*\*submitted:\*\*/g)).toHaveLength(2);
  });

  test("an id or hash that isn't there, or an entry missing a field, sends nothing and says which", async () => {
    const t = await setup();
    await t.write('A bug', 'Body.');
    const unknown = await t.cli(['feedback', 'submit', '2026-01-01.9', '--preview']);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toContain('2026-01-01.9');

    await writeFile(
      join(t.pack, 'FEEDBACK.md'),
      (await t.feedback()).replace(/- \*\*severity:\*\* medium\n/, ''),
    );
    const broken = await t.cli(['feedback', 'submit', '--preview']);
    expect(broken.exitCode).toBe(1);
    expect(broken.stderr).toMatch(/\d{4}-\d{2}-\d{2}\.1: its severity must be one of/);
    expect(t.service.requests).toEqual([]);
  });

  test('a body past 16 KiB is refused before sending, never cut short', async () => {
    const t = await setup();
    await t.write('A long one', 'x'.repeat(16 * 1024 + 1));
    const out = await t.cli(['feedback', 'submit', '--preview']);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('at most 16384: shorten it');
  });

  test('past 20 entries, the first 20 go and the rest wait; named ones must all fit', async () => {
    const t = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) ids.push(await t.write(`Bug number ${i}`, 'Body.'));
    const preview = json((await t.cli(['feedback', 'submit', '--preview'])).stdout);
    expect(preview.payload.entries.map((e: { entry: string }) => e.entry)).toEqual(
      ids.slice(0, 20),
    );
    expect(preview.held).toBe(1);

    const named = await t.cli(['feedback', 'submit', ...ids, '--preview']);
    expect(named.exitCode).not.toBe(0);
    expect(named.stderr).toContain("don't fit one report");
  });

  test('the pack config’s dev.envFiles are redacted too', async () => {
    const t = await setup();
    await mkdir(join(t.pack, 'config'));
    await writeFile(join(t.pack, 'config', 'dev.env'), 'ACME_INTERNAL_HOST=build7.acme.internal\n');
    await t.write('A bug', 'It called build7.acme.internal');
    const out = await t.cli(['feedback', 'submit', '--preview'], {
      buildConfigLoader: async () => ({ dev: { envFiles: ['config/dev.env'] } }),
    });
    expect(json(out.stdout).payload.entries[0].body).toBe('It called [redacted]');
  });

  test.each([
    [
      'rate-limited',
      () =>
        new Response(JSON.stringify({ error: 'rate-limited', message: 'Too many.' }), {
          status: 429,
          headers: { 'retry-after': '42' },
        }),
      'Nothing was sent: the intake is taking no more reports for now; try again in 42 s',
    ],
    [
      'refused',
      () =>
        Response.json(
          { error: 'invalid-request', message: 'entries[0].body is too long.' },
          { status: 400 },
        ),
      'The intake refused the report (400 invalid-request): entries[0].body is too long.',
    ],
    [
      'a 4xx page from in front of the intake',
      () => new Response('<html>not found</html>', { status: 404 }),
      `Nothing reached Kindgi: ${ORIGIN} answered 404.`,
    ],
  ])(
    '%s: nothing reached Kindgi, FEEDBACK.md and the keys are unchanged, and stdout has what would have been sent',
    async (_name, answer, says) => {
      const t = await setup();
      await t.write('A bug', 'Body.');
      const { digest } = json((await t.cli(['feedback', 'submit', '--preview'])).stdout);
      const before = await t.feedback();
      t.service.answerWith(answer);
      const out = await t.cli(['feedback', 'submit', `--yes=${digest}`]);
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(says);
      expect(out.stderr).toContain(
        'FEEDBACK.md is unchanged; what would have been sent is on stdout',
      );
      expect(out.stderr).not.toContain('may have received');
      expect(json(out.stdout)).toMatchObject({ digest, received: 'no' });
      expect(await t.feedback()).toBe(before);
      expect(await t.keys()).toEqual({});
    },
  );

  test.each([
    [
      'a 5xx page',
      () => new Response('<html>bad gateway</html>', { status: 502 }),
      `${ORIGIN} answered 502`,
    ],
    [
      "the intake's 503",
      () =>
        Response.json(
          { error: 'unavailable', message: "Kindgi's intake can't answer just now." },
          { status: 503 },
        ),
      `${ORIGIN} answered 503 (unavailable)`,
    ],
    [
      'a 201 it can’t read',
      () =>
        Response.json(
          { reports: [{ entry: 'x', reportId: 'nope', withdrawKey: 'nope' }] },
          { status: 201 },
        ),
      `${ORIGIN}'s answer wasn't one this CLI can read`,
    ],
    [
      'a 201 whose key isn’t a withdraw key',
      (_path: string, body: string) =>
        Response.json(
          {
            reports: JSON.parse(body).entries.map((e: { entry: string }) => ({
              entry: e.entry,
              reportId: `fbr_${'A'.repeat(16)}`,
              withdrawKey: `kgi_ak_${'A'.repeat(22)}`,
            })),
          },
          { status: 201 },
        ),
      `${ORIGIN}'s answer wasn't one this CLI can read`,
    ],
  ])(
    '%s: Kindgi may have it, so it never says nothing was sent, and says a resend makes a second report',
    async (_name, answer, says) => {
      const t = await setup();
      await t.write('A bug', 'Body.');
      const { digest } = json((await t.cli(['feedback', 'submit', '--preview'])).stdout);
      const before = await t.feedback();
      t.service.answerWith(answer);
      const out = await t.cli(['feedback', 'submit', `--yes=${digest}`]);
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(`Kindgi may have received it: ${says}`);
      expect(out.stderr).toContain('sending it again makes a second report');
      expect(out.stderr).toContain("can't be withdrawn from this machine");
      expect(out.stderr).not.toMatch(/Nothing (was sent|was stored|reached)/);
      expect(json(out.stdout)).toMatchObject({ digest, received: 'maybe' });
      expect(await t.feedback()).toBe(before);
      expect(await t.keys()).toEqual({});
    },
  );

  test.each([
    [
      'a name that never resolved',
      'ENOTFOUND',
      'getaddrinfo ENOTFOUND access.kindgi.com',
      'no',
      "Nothing reached Kindgi: https://access.kindgi.com couldn't be reached (getaddrinfo ENOTFOUND access.kindgi.com)",
    ],
    [
      'nothing listening',
      'ECONNREFUSED',
      'connect ECONNREFUSED 127.0.0.1:443',
      'no',
      'Nothing reached Kindgi',
    ],
    [
      'a certificate refused',
      'CERT_HAS_EXPIRED',
      'certificate has expired',
      'no',
      'Nothing reached Kindgi',
    ],
    [
      'a connection dropped',
      'ECONNRESET',
      'read ECONNRESET',
      'maybe',
      "Kindgi may have received it: https://access.kindgi.com couldn't be reached (read ECONNRESET)",
    ],
  ])(
    'the intake out of reach, %s: said as the network says it',
    async (_name, code, message, received, says) => {
      const t = await setup();
      await t.write('A bug', 'Body.');
      const { digest } = json((await t.cli(['feedback', 'submit', '--preview'])).stdout);
      const failing = (async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });
      }) as typeof fetch;
      const out = await t.cli(['feedback', 'submit', `--yes=${digest}`], { fetchImpl: failing });
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(says);
      expect(json(out.stdout)).toMatchObject({ received });
      expect((await t.feedback()).includes('submitted')).toBe(false);
    },
  );

  test('no answer in time: Kindgi may have received it', async () => {
    const t = await setup();
    await t.write('A bug', 'Body.');
    const { digest } = json((await t.cli(['feedback', 'submit', '--preview'])).stdout);
    const slow = (async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as typeof fetch;
    const out = await t.cli(['feedback', 'submit', `--yes=${digest}`], { fetchImpl: slow });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      "Kindgi may have received it: https://access.kindgi.com couldn't be reached (no answer in time)",
    );
    expect(json(out.stdout)).toMatchObject({ received: 'maybe' });
  });

  test("keys that can't be kept once the intake has the reports: the submitted lines still go in, and it says so", async () => {
    const t = await setup();
    const id = await t.write('A bug', 'Body.');
    const { digest } = json((await t.cli(['feedback', 'submit', '--preview'])).stdout);
    t.service.answerWith((path) => {
      if (path === '/feedback/reports') {
        rmSync(t.keysFile);
        mkdirSync(t.keysFile);
      }
      return undefined;
    });
    const out = await t.cli(['feedback', 'submit', `--yes=${digest}`]);
    expect(out.exitCode).toBe(1);
    const value = json(out.stdout);
    expect(value.reports).toEqual([{ entry: id, reportId: expect.stringMatching(/^fbr_/) }]);
    expect(value.keys).toBeUndefined();
    expect(out.stderr).toContain('✓ sent 1 report to Kindgi.');
    expect(out.stderr).toContain(`Its key couldn't be kept in ${t.keysFile} (`);
    expect(out.stderr).toContain("so it can't be withdrawn from this machine");
    expect(out.stderr).not.toContain('records each report id');
    expect(await t.feedback()).toContain(`**report:** ${value.reports[0].reportId}`);
    const again = await t.cli(['feedback', 'submit', '--preview']);
    expect(json(again.stdout).reports).toEqual([]);
  });

  test("a FEEDBACK.md that can't be marked once the intake has the reports: the keys are kept, and it says so", async () => {
    const t = await setup();
    await t.write('A bug', 'Body.');
    const { digest } = json((await t.cli(['feedback', 'submit', '--preview'])).stdout);
    const file = join(t.pack, 'FEEDBACK.md');
    t.service.answerWith((path) => {
      if (path === '/feedback/reports') {
        rmSync(file);
        mkdirSync(file);
      }
      return undefined;
    });
    const out = await t.cli(['feedback', 'submit', `--yes=${digest}`]);
    expect(out.exitCode).toBe(1);
    const value = json(out.stdout);
    expect(value.keys).toBe(t.keysFile);
    expect(Object.keys(await t.keys())).toEqual([value.reports[0].reportId]);
    expect(out.stderr).toContain('✓ sent 1 report to Kindgi.');
    expect(out.stderr).toContain("FEEDBACK.md couldn't be marked (");
    expect(out.stderr).toContain('Sending those entries again makes a second report.');
  });

  test("a keys.json this CLI didn't write stops the send before anything goes", async () => {
    const t = await setup();
    await t.write('A bug', 'Body.');
    await mkdir(join(t.home, '.kindgi', 'feedback'), { recursive: true });
    await writeFile(t.keysFile, '[1, 2]');
    const { digest } = json((await t.cli(['feedback', 'submit', '--preview'])).stdout);
    const out = await t.cli(['feedback', 'submit', `--yes=${digest}`]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("isn't a file this CLI wrote");
    expect(t.service.requests).toEqual([]);
    expect(await readFile(t.keysFile, 'utf8')).toBe('[1, 2]');
  });
});

/** A pack with `n` entries sent; their report ids, in order. */
async function sent(
  t: Awaited<ReturnType<typeof setup>>,
  n: number,
): Promise<{ ids: string[]; reportIds: string[] }> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await t.write(`Bug ${i}`, 'Body.'));
  const { digest } = json((await t.cli(['feedback', 'submit', '--preview'])).stdout);
  const out = json((await t.cli(['feedback', 'submit', `--yes=${digest}`])).stdout);
  return { ids, reportIds: out.reports.map((r: { reportId: string }) => r.reportId) };
}

describe('kindgi feedback status', () => {
  test('asks about every report sent, records the answers, and marks a fixed one in FEEDBACK.md', async () => {
    const t = await setup();
    const { ids, reportIds } = await sent(t, 3);
    const [a, b, c] = reportIds as [string, string, string];
    Object.assign(t.service.reports.get(a) as Stored, {
      state: 'fixed',
      fixedIn: '0.1.9',
      issueUrl: 'https://github.com/kindgi/kindgi-sdk/issues/1',
    });
    Object.assign(t.service.reports.get(b) as Stored, {
      state: 'wont-fix',
      reason: 'Works as designed.',
    });
    const before = t.service.requests.length;

    const out = await t.cli(['feedback', 'status']);
    expect(out.exitCode).toBe(0);
    expect(t.service.requests.slice(before).map((r) => r.path)).toEqual([
      '/feedback/reports/status',
    ]);
    expect(json(out.stdout).reports).toEqual([
      {
        reportId: a,
        entry: ids[0],
        state: 'fixed',
        issueUrl: 'https://github.com/kindgi/kindgi-sdk/issues/1',
        fixedIn: '0.1.9',
        asked: true,
        askedAt: new Date(NOW).toISOString(),
      },
      {
        reportId: b,
        entry: ids[1],
        state: 'wont-fix',
        reason: 'Works as designed.',
        asked: true,
        askedAt: new Date(NOW).toISOString(),
      },
      {
        reportId: c,
        entry: ids[2],
        state: 'received',
        asked: true,
        askedAt: new Date(NOW).toISOString(),
      },
    ]);
    const file = await t.feedback();
    expect(file).toContain(`> **Fixed:** in 0.1.9 (report ${a})`);
    expect(file.match(/> \*\*Fixed:\*\* in /g)).toHaveLength(1);
  });

  test('asks at most once a day unless named, and never again once a report is final', async () => {
    const t = await setup();
    const { ids, reportIds } = await sent(t, 2);
    Object.assign(t.service.reports.get(reportIds[0] as string) as Stored, {
      state: 'fixed',
      fixedIn: '0.1.9',
    });
    await t.cli(['feedback', 'status']);
    const asked = () =>
      t.service.requests
        .filter((r) => r.path === '/feedback/reports/status')
        .map((r) => JSON.parse(r.body).reportIds);

    t.later(HOUR);
    const soon = json((await t.cli(['feedback', 'status'])).stdout);
    expect(asked()).toHaveLength(1);
    expect(soon.reports.map((r: { asked: boolean; state: string }) => [r.state, r.asked])).toEqual([
      ['fixed', false],
      ['received', false],
    ]);

    await t.cli(['feedback', 'status', ids[1] as string]);
    expect(asked()[1]).toEqual([reportIds[1]]);

    t.later(24 * HOUR);
    await t.cli(['feedback', 'status']);
    expect(asked()[2]).toEqual([reportIds[1]]);
    // Named, a final one still isn't asked about again.
    await t.cli(['feedback', 'status', ids[0] as string]);
    expect(asked()).toHaveLength(3);
  });

  test("one the intake doesn't have is asked about once, then again only when named", async () => {
    const t = await setup();
    const { ids, reportIds } = await sent(t, 1);
    t.service.reports.delete(reportIds[0] as string);
    const asked = () =>
      t.service.requests.filter((r) => r.path === '/feedback/reports/status').length;
    const first = json((await t.cli(['feedback', 'status'])).stdout);
    expect(first.reports[0]).toMatchObject({ state: 'unknown', asked: true });
    t.later(48 * HOUR);
    const later = json((await t.cli(['feedback', 'status'])).stdout);
    expect(asked()).toBe(1);
    expect(later.reports[0]).toMatchObject({ state: 'unknown', asked: false });
    await t.cli(['feedback', 'status', ids[0] as string]);
    expect(asked()).toBe(2);
  });

  test("a teammate's report id works without FEEDBACK.md or a key, and an unknown one says unknown", async () => {
    const t = await setup();
    const { reportIds } = await sent(t, 1);
    const other = await setup();
    const out = await other.cli(
      ['feedback', 'status', reportIds[0] as string, 'fbr_AAAAAAAAAAAAAAAA'],
      {
        fetchImpl: t.service.fetchImpl,
      },
    );
    expect(out.exitCode).toBe(0);
    expect(json(out.stdout).reports.map((r: { state: string }) => r.state)).toEqual([
      'received',
      'unknown',
    ]);
  });

  test('asks 50 at a time, and works with sending turned off', async () => {
    const t = await setup({ env: { KINDGI_FEEDBACK_SUBMIT: 'off' } });
    const ids = Array.from({ length: 51 }, (_, i) => `fbr_${String(i).padStart(16, 'A')}`);
    const out = await t.cli(['feedback', 'status', ...ids]);
    expect(out.exitCode).toBe(0);
    expect(t.service.requests.map((r) => JSON.parse(r.body).reportIds.length)).toEqual([50, 1]);
  });

  test('a later 50 the intake is too busy for: only those are named as not asked', async () => {
    const t = await setup();
    const ids = Array.from({ length: 51 }, (_, i) => `fbr_${String(i).padStart(16, 'A')}`);
    let asks = 0;
    t.service.answerWith((path) =>
      path === '/feedback/reports/status' && ++asks === 2
        ? new Response(JSON.stringify({ error: 'rate-limited', message: 'Busy.' }), {
            status: 429,
            headers: { 'retry-after': '30' },
          })
        : undefined,
    );
    const out = await t.cli(['feedback', 'status', ...ids]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(`Not asked about: ${ids[50]}.`);
  });

  test('an intake that is busy keeps the answers had, and names the reports not asked', async () => {
    const t = await setup();
    const { reportIds } = await sent(t, 1);
    t.service.answerWith(
      () =>
        new Response(JSON.stringify({ error: 'rate-limited', message: 'Busy.' }), {
          status: 429,
          headers: { 'retry-after': '30' },
        }),
    );
    const out = await t.cli(['feedback', 'status']);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(`try again in 30 s. Not asked about: ${reportIds[0]}.`);
    expect(json(out.stdout).reports[0]).toMatchObject({ state: 'not-asked', asked: false });
  });
});

describe('kindgi feedback withdraw', () => {
  test("takes a report back with this machine's key: the key goes, FEEDBACK.md and status say withdrawn", async () => {
    const sender = await setup();
    const { ids, reportIds } = await sent(sender, 2);
    // Sending turned off since: withdraw still works.
    const out = await sender.cli(['feedback', 'withdraw', ids[0] as string], {
      env: { HOME: sender.home, KINDGI_FEEDBACK_SUBMIT: 'off' },
    });
    expect(out.exitCode).toBe(0);
    expect(json(out.stdout)).toEqual({ withdrawn: [reportIds[0]] });
    expect(sender.service.reports.get(reportIds[0] as string)?.withdrawn).toBe(true);
    expect(Object.keys(await sender.keys())).toEqual([reportIds[1]]);
    expect(await sender.feedback()).toMatch(
      new RegExp(`report:\\*\\* ${reportIds[0]} · \\*\\*withdrawn:\\*\\* `),
    );

    const status = json((await sender.cli(['feedback', 'status', ids[0] as string])).stdout);
    expect(status.reports[0]).toMatchObject({ state: 'withdrawn', asked: false });

    const withdraws = () =>
      sender.service.requests.filter((r) => r.path === '/feedback/reports/withdraw').length;
    expect(withdraws()).toBe(1);
    const again = await sender.cli(['feedback', 'withdraw', ids[0] as string]);
    expect(again.exitCode).toBe(0);
    expect(json(again.stdout)).toEqual({ withdrawn: [], alreadyWithdrawn: [reportIds[0]] });
    expect(withdraws()).toBe(1);
  });

  test('a key the intake refuses, a report with no key here, and nothing named, each said', async () => {
    const t = await setup();
    const { reportIds } = await sent(t, 2);
    const keys = await t.keys();
    keys[reportIds[0] as string].withdrawKey = `kgi_fw_${'A'.repeat(22)}`;
    await writeFile(t.keysFile, JSON.stringify({ reports: keys }));
    const other = 'fbr_BBBBBBBBBBBBBBBB';
    const out = await t.cli(['feedback', 'withdraw', reportIds[0] as string, other]);
    expect(out.exitCode).toBe(1);
    expect(json(out.stdout)).toEqual({ withdrawn: [], refused: [reportIds[0]], noKey: [other] });
    expect(out.stderr).toContain('Refused');
    expect(out.stderr).toContain('the key stays on the machine that sent the report');
    expect(Object.keys(await t.keys()).sort()).toEqual([...reportIds].sort());

    const none = await t.cli(['feedback', 'withdraw']);
    expect(none.exitCode).not.toBe(0);
    expect(none.stderr).toContain('Name the reports to withdraw');
  });

  test('an answer lost on the way back may follow a withdraw that worked: it says so, and withdrawing again is safe', async () => {
    const t = await setup();
    const { reportIds } = await sent(t, 1);
    const [id] = reportIds as [string];
    t.service.answerWith((path) => {
      if (path !== '/feedback/reports/withdraw') return undefined;
      (t.service.reports.get(id) as Stored).withdrawn = true;
      return new Response('<html>bad gateway</html>', { status: 502 });
    });
    const out = await t.cli(['feedback', 'withdraw', id]);
    expect(out.exitCode).toBe(1);
    // One report: it's named, with no "some of".
    expect(out.stderr).toContain(`${id} may have been withdrawn: run it again to know`);
    expect(out.stderr).not.toContain('Some of');
    expect(out.stderr).not.toContain('Not withdrawn');
    expect(Object.keys(await t.keys())).toEqual([id]);

    t.service.answerWith(() => undefined);
    const again = await t.cli(['feedback', 'withdraw', id]);
    expect(again.exitCode).toBe(0);
    expect(json(again.stdout)).toEqual({ withdrawn: [id] });
    expect(await t.keys()).toEqual({});
  });

  test('a withdraw the intake answered none of names each report left: maybe withdrawn when it may have arrived, not withdrawn when it did not', async () => {
    const t = await setup();
    const { reportIds } = await sent(t, 2);
    const [a, b] = reportIds as [string, string];
    t.service.answerWith((path) =>
      path === '/feedback/reports/withdraw'
        ? new Response('<html>bad gateway</html>', { status: 502 })
        : undefined,
    );
    const maybe = await t.cli(['feedback', 'withdraw', a, b]);
    expect(maybe.exitCode).toBe(1);
    expect(maybe.stderr).toContain(`Some of ${a}, ${b} may have been withdrawn: run it again`);

    // A 404 that isn't the intake's: nothing reached it.
    t.service.answerWith((path) =>
      path === '/feedback/reports/withdraw'
        ? new Response('<html>not found</html>', { status: 404 })
        : undefined,
    );
    const no = await t.cli(['feedback', 'withdraw', a, b]);
    expect(no.exitCode).toBe(1);
    expect(no.stderr).toContain(`Not withdrawn: ${a}, ${b}.`);
    expect(no.stderr).not.toContain('may have been withdrawn');
    expect(Object.keys(await t.keys()).sort()).toEqual([a, b].sort());
  });

  test('a later 50 whose answer is lost: only those are named as maybe withdrawn', async () => {
    const t = await setup();
    const { reportIds } = await sent(t, 1);
    const keys = await t.keys();
    const more = Array.from({ length: 50 }, (_, i) => `fbr_${String(i).padStart(16, 'B')}`);
    for (const id of more) keys[id] = { ...keys[reportIds[0] as string] };
    await writeFile(t.keysFile, JSON.stringify({ reports: keys }));
    let asks = 0;
    t.service.answerWith((path) =>
      path === '/feedback/reports/withdraw' && ++asks === 2
        ? new Response('<html>bad gateway</html>', { status: 502 })
        : undefined,
    );
    const out = await t.cli(['feedback', 'withdraw', reportIds[0] as string, ...more]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(`${more[49]} may have been withdrawn: run it again`);
    expect(out.stderr).not.toContain('Some of');
  });
});

describe('kindgi feedback write', () => {
  test('says where the entry went, and nothing under --quiet; the entry is written either way', async () => {
    const said: string[] = [];
    const { cli, feedback } = await setup();
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      said.push(String(chunk));
      return true;
    });
    const argv = (title: string) => [
      'feedback',
      'write',
      '--kind=bug',
      `--title=${title}`,
      '--body=It broke.',
      '--authored-by=claude-code',
    ];
    try {
      const loud = await cli(argv('Loud'));
      expect(loud.exitCode, loud.stderr).toBe(0);
      expect(said.join('')).toContain(`✓ appended entry ${json(loud.stdout).id} to `);
      said.length = 0;
      const quiet = await cli([...argv('Quiet'), '--quiet']);
      expect([quiet.exitCode, quiet.stdout, quiet.stderr]).toEqual([0, '', '']);
      expect(said.join('')).toBe('');
    } finally {
      spy.mockRestore();
    }
    expect(await feedback()).toContain('Quiet');
  });
});

describe('the keys file', () => {
  test('ten sends at once lose no key', async () => {
    const { updateKeys, feedbackFiles, readKeys } = await import('../src/feedback/store.js');
    const home = await mkdtemp(join(tmpdir(), 'acme-feedback-keys-'));
    dirs.push(home);
    const files = feedbackFiles(home);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        updateKeys(files, (keys) => {
          keys[`fbr_${String(i).padStart(16, 'A')}`] = {
            withdrawKey: `kgi_fw_${'A'.repeat(22)}`,
            entry: `2026-10-15.${i + 1}`,
            submittedAt: 'x',
          };
        }),
      ),
    );
    expect(Object.keys(await readKeys(files))).toHaveLength(10);
  });
});

// Last, over every output above.
test('no withdrawKey shows in any output', () => {
  expect(printed.length).toBeGreaterThan(50);
  expect(printed.join('\n')).not.toMatch(/kgi_fw_/);
});
