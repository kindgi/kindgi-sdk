// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import {
  type RedactionContext,
  readPackEnvEntries,
  redactForSending,
} from '../src/feedback/redact.js';

const posix: RedactionContext = {
  packDir: '/Users/acme-dev/work/acme-pack',
  home: '/Users/acme-dev',
  envEntries: [],
};

const windows: RedactionContext = {
  packDir: 'C:\\Users\\acme-dev\\work\\acme-pack',
  home: 'C:\\Users\\acme-dev',
  envEntries: [],
};

const redact = (text: string, ctx: RedactionContext = posix): string =>
  redactForSending(text, ctx).text;

/** A key-shaped string built at run time, so no scanner reads this file as holding one. */
const fake = (prefix: string, length: number): string =>
  prefix + 'a1B2c3D4'.repeat(Math.ceil(length / 8)).slice(0, length);

describe('private keys', () => {
  test('a PEM private key block goes whole, to its END line', () => {
    const pem = `-----BEGIN ${'PRIVATE'} KEY-----\nMIIEvQIBADANBg\nkqhkiG9w0BAQEF\n-----END ${'PRIVATE'} KEY-----`;
    expect(redact(`before\n${pem}\nafter`)).toBe('before\n[redacted]\nafter');
  });

  test('a block cut short goes to the end of the text', () => {
    expect(redact(`key:\n-----BEGIN EC ${'PRIVATE'} KEY-----\nMHcCAQEEI`)).toBe('key:\n[redacted]');
  });
});

describe("the pack's env values", () => {
  const ctx: RedactionContext = {
    ...posix,
    envEntries: [
      { key: 'ACME_WEBHOOK_URL', value: 'https://hooks.acme.test/in' },
      { key: 'ACME_TOKEN', value: 'q9z7' },
      { key: 'PORT', value: '3000' },
      { key: 'ACME_NAME', value: 'acmecorp' },
      { key: 'ACME_NAME_FULL', value: 'acmecorp-internal' },
      { key: 'ACME_REF', value: '${ACME_TOKEN}' },
    ],
  };

  test('a value of 8 characters or more goes wherever it appears', () => {
    expect(redact('posted to https://hooks.acme.test/in twice', ctx)).toBe(
      'posted to [redacted] twice',
    );
  });

  test('a short value stays, unless its key looks secret', () => {
    expect(redact('PORT 3000, token q9z7', ctx)).toBe('PORT 3000, token [redacted]');
  });

  test('the longest value goes first, so one that holds another goes whole', () => {
    expect(redact('host acmecorp-internal.example', ctx)).toBe('host [redacted].example');
  });

  test('a reference to another variable is not a value', () => {
    expect(redact('set ACME_REF to ${ACME_TOKEN}', ctx)).toBe('set ACME_REF to ${ACME_TOKEN}');
  });
});

describe('tokens', () => {
  test('a Kindgi token is masked as the logs mask it: its prefix and last four characters', () => {
    const token = `kgi_ak_${'x'.repeat(28)}WXYZ`;
    expect(redact(`key ${token} failed`)).toBe('key kgi_ak_…WXYZ failed');
  });

  test.each([
    ['OpenAI', fake('sk-proj-', 40)],
    ['Anthropic', fake('sk-ant-api03-', 40)],
    ['OpenRouter', fake('sk-or-v1-', 48)],
    ['AWS', `AKIA${'ABCDEFGHIJ234567'}`],
    ['GitHub', fake('ghp_', 36)],
    ['GitHub fine-grained', fake('github_pat_', 40)],
    ['Slack', fake('xoxb-', 24)],
    ['Google', fake('AIza', 35)],
    ['Stripe', fake(`sk_${'live'}_`, 24)],
    ['SendGrid', `SG.${fake('', 22)}.${fake('', 43)}`],
    ['Hugging Face', fake('hf_', 34)],
    ['a JWT', `eyJ${fake('', 20)}.eyJ${fake('', 20)}.${fake('', 30)}`],
  ])('a %s key goes by its shape', (_name, key) => {
    expect(redact(`it printed ${key} then exited`)).toBe('it printed [redacted] then exited');
  });

  test('Bearer and a URL password are masked as the logs mask them, and the user info goes too', () => {
    expect(redact('Bearer abc.def-123')).toBe('Bearer [redacted]');
    expect(redact('postgres://app:hunter2@db.acme.test:5432/app')).toBe(
      'postgres://[redacted]@db.acme.test:5432/app',
    );
  });

  test('the value under a key that looks secret goes, in every form', () => {
    expect(redact('ACME_API_KEY=abc123 and --api-key=abc123')).toBe(
      'ACME_API_KEY=[redacted] and --api-key=[redacted]',
    );
    expect(redact("password = 'two words'")).toBe("password = '[redacted]'");
    expect(redact('{"clientSecret": "abc", "name": "acme"}')).toBe(
      '{"clientSecret": "[redacted]", "name": "acme"}',
    );
    expect(redact('Authorization: Basic YWNtZTpodW50ZXIy\nAccept: */*')).toBe(
      'Authorization: [redacted]\nAccept: */*',
    );
    expect(redact('DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=abc==;')).toBe(
      'DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=[redacted];',
    );
  });

  test('a key that only sounds secret, and a placeholder, stay', () => {
    expect(redact('tokenCount=12 limit=25 ACME_TOKEN=${ACME_TOKEN} password=<yours>')).toBe(
      'tokenCount=12 limit=25 ACME_TOKEN=${ACME_TOKEN} password=<yours>',
    );
  });
});

describe('URLs', () => {
  test('each query value goes, the names and the fragment stay', () => {
    expect(redact('see https://acme.test/cb?code=abc&state=xyz&debug#top')).toBe(
      'see https://acme.test/cb?code=[redacted]&state=[redacted]&[redacted]#top',
    );
  });

  test('a URL with no user info or query is left as it is', () => {
    expect(redact('docs at https://docs.kindgi.com/v0.1/start/')).toBe(
      'docs at https://docs.kindgi.com/v0.1/start/',
    );
  });
});

describe('emails', () => {
  test('an email address goes; a package version is not one', () => {
    expect(redact('ask dev@acme.test about @kindgi/cli@0.1.8')).toBe(
      'ask [email] about @kindgi/cli@0.1.8',
    );
  });
});

describe('paths', () => {
  test('a path in the pack becomes relative to it, and the pack itself is .', () => {
    expect(
      redact(
        'at /Users/acme-dev/work/acme-pack/src/tool.ts:12:5 in /Users/acme-dev/work/acme-pack',
      ),
    ).toBe('at ./src/tool.ts:12:5 in .');
  });

  test('a sibling that starts with the pack name is not the pack', () => {
    expect(redact('/Users/acme-dev/work/acme-pack-old/x.ts')).toBe('[path]');
  });

  test('the home directory is ~, and a path under it goes', () => {
    expect(redact('HOME is /Users/acme-dev; config at /Users/acme-dev/.config/acme/x.json')).toBe(
      'HOME is ~; config at [path]',
    );
    expect(redact('see ~/clients/acme/notes.md')).toBe('see [path]');
  });

  test('a path at a filesystem root goes, and keeps what follows a colon', () => {
    expect(redact('/tmp/acme-123/out.log:4 and /home/ci/acme/build and /var')).toBe(
      '[path]:4 and [path] and [path]',
    );
  });

  test("an API route, a URL's path and a relative path stay", () => {
    expect(
      redact('GET /v1/secrets?limit=25 at http://localhost:3000/app/x from ./data/a.json'),
    ).toBe('GET /v1/secrets?limit=25 at http://localhost:3000/app/x from ./data/a.json');
  });

  test('on Windows: either separator, any case, and JSON-escaped', () => {
    expect(redact('at C:\\Users\\acme-dev\\work\\acme-pack\\src\\tool.ts', windows)).toBe(
      'at .\\src\\tool.ts',
    );
    expect(redact('at c:/users/acme-dev/work/acme-pack/src/tool.ts', windows)).toBe(
      'at ./src/tool.ts',
    );
    expect(redact('{"dir":"C:\\\\Users\\\\acme-dev\\\\work\\\\acme-pack\\\\src"}', windows)).toBe(
      '{"dir":".\\\\src"}',
    );
    expect(
      redact('HOME C:\\Users\\acme-dev, D:\\acme\\data.csv, \\\\fileserver\\acme\\x', windows),
    ).toBe('HOME ~, [path], [path]');
  });
});

describe('what it reports', () => {
  test('the rules that changed something, in the order they ran', () => {
    const r = redactForSending('mail dev@acme.test from /tmp/x with Bearer abc', posix);
    expect(r.applied).toEqual(['tokens', 'emails', 'paths']);
  });

  test('text with nothing to take out comes back as it was', () => {
    const text = 'kindgi dev fails on Windows when the path has a space';
    expect(redactForSending(text, posix)).toEqual({ text, applied: [] });
  });
});

describe('readPackEnvEntries', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  test("every entry of every env file: .env*, dev.envFiles and Kindgi's secrets file", async () => {
    const pack = await mkdtemp(join(tmpdir(), 'acme-feedback-'));
    dirs.push(pack);
    await mkdir(join(pack, '.kindgi'));
    await mkdir(join(pack, 'config'));
    await mkdir(join(pack, '.env.d'));
    await writeFile(join(pack, '.env'), 'ACME_KEY=from-env\n# a comment\nPORT=3000\n');
    await writeFile(join(pack, '.env.local'), 'ACME_KEY=from-env-local\n');
    await writeFile(join(pack, '.kindgi', 'secrets.env'), 'ACME_SECRET=from-kindgi\n');
    await writeFile(join(pack, 'config', 'dev.env'), 'ACME_EXTRA=from-config\n');
    const entries = await readPackEnvEntries(pack, ['config/dev.env', 'missing.env']);
    expect(entries.map((e) => `${e.key}=${e.value}`).sort()).toEqual([
      'ACME_EXTRA=from-config',
      'ACME_KEY=from-env',
      'ACME_KEY=from-env-local',
      'ACME_SECRET=from-kindgi',
      'PORT=3000',
    ]);
  });

  test('a pack that is not there has none', async () => {
    expect(await readPackEnvEntries(join(tmpdir(), 'acme-feedback-none', 'x'))).toEqual([]);
  });
});
