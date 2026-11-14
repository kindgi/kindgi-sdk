// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The CLI's text masks give their patterns' own output, in time in step
 * with the text's length: a URL's user info in a tool's error line, and a
 * feedback report's URLs, `key=value` secrets and JWTs. Each pattern tries
 * a start at every word, or every letter, in a long run of its characters,
 * and each start walks to the run's end before it fails, so its time grows
 * with the square of the run.
 */

import { REDACTED } from '@kindgi/log';
import { describe, expect, test } from 'vitest';

import { withoutCredentials } from '../src/commands/suggested-changes-pull.js';
import {
  type RedactionContext,
  maskJwts,
  redactForSending,
  replaceAssignments,
  replaceUrlsInText,
} from '../src/feedback/redact.js';

const ctx: RedactionContext = {
  packDir: '/Users/acme-dev/work/acme-pack',
  home: '/Users/acme-dev',
  envEntries: [],
};

/** A JWT-shaped string built at run time from runs of one letter, so it looks like no real token. */
const jwt = (a: number, b: number, c: number): string =>
  `eyJ${'a'.repeat(a)}.eyJ${'b'.repeat(b)}.${'c'.repeat(c)}`;

const nbsp = String.fromCharCode(0xa0);

/** How long `run` takes, in ms. */
function timed(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

/** Each text goes through `mask` unchanged, in under `ms`. */
function unchangedInTime(mask: (text: string) => string, texts: readonly string[], ms = 500) {
  for (const text of texts) {
    let out: string | undefined;
    expect(
      timed(() => {
        out = mask(text);
      }),
      text.slice(-8),
    ).toBeLessThan(ms);
    expect(out === text, text.slice(-8)).toBe(true);
  }
}

describe("a URL's user info in a tool's error line", () => {
  // The pattern `withoutCredentials` replaced: the reference.
  const USER_INFO = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;

  test('goes where the pattern takes it out, in time in step with the line', () => {
    const fatal = "fatal: unable to access 'https://u:tok@github.com/acme/pack.git/'";
    for (const text of [
      fatal,
      'https://tok@host/x',
      '1a://u@h',
      '_a://u@h',
      '1.2://u@h',
      'a://@h',
      'a://u@b://v@c',
      'a://x/y@z',
      'a://b://c@d',
      'HTTPS://U@H',
      `a://u${nbsp}v@h`,
      'a://u:p@h',
      'x://u@h y://v@w',
    ]) {
      expect(withoutCredentials(text), text).toBe(text.replace(USER_INFO, '$1'));
    }
    expect(withoutCredentials(fatal)).toBe(
      "fatal: unable to access 'https://github.com/acme/pack.git/'",
    );
    expect(withoutCredentials('https://tok@host/x')).toBe('https://host/x');
    expect(withoutCredentials('1a://u@h')).toBe('1a://h');
    expect(withoutCredentials('_a://u@h')).toBe('_a://h');
    expect(withoutCredentials('1.2://u@h')).toBe('1.2://u@h');
    expect(withoutCredentials('a://@h')).toBe('a://@h');
    expect(withoutCredentials('a://u@b://v@c')).toBe('a://b://c');
    expect(withoutCredentials('a://x/y@z')).toBe('a://x/y@z');
    expect(withoutCredentials('a://b://c@d')).toBe('a://b://d');
    expect(withoutCredentials('HTTPS://U@H')).toBe('HTTPS://H');

    // 64 KiB each. The pattern takes seconds on these.
    const half = 'a'.repeat(32 * 1024);
    unchangedInTime(withoutCredentials, [half + half, `${half}://${'b'.repeat(32 * 1024)}`]);
  });
});

describe("a feedback report's URLs", () => {
  // The pattern `replaceUrlsInText` replaced, and a callback that marks each
  // match's place and both its groups.
  const URL_IN_TEXT = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s"'<>`]+)/gi;
  const mark = (_m: string, scheme: string, rest: string): string => `<${scheme}|${rest}>`;

  test('are found where the pattern finds them, in time in step with the text', () => {
    for (const text of [
      'see https://acme.test/cb?code=abc&state=xyz&debug#top',
      '1.https://h?x=1',
      '_a://h?x=1',
      'a:// x',
      'a://"x"',
      'a://',
      'https://a.test/?next=https://b.test/?t=1',
      'a://x b://y',
      'HTTPS://H',
      `a://x${nbsp}y`,
      'ab-c://x',
    ]) {
      expect(replaceUrlsInText(text, mark), text).toBe(text.replace(URL_IN_TEXT, mark));
    }
    expect(replaceUrlsInText('1.https://h?x=1', mark)).toBe('1.<https://|h?x=1>');
    expect(replaceUrlsInText('_a://h?x=1', mark)).toBe('_a://h?x=1');
    expect(replaceUrlsInText('a:// x', mark)).toBe('a:// x');
    expect(replaceUrlsInText('https://a.test/?next=https://b.test/?t=1', mark)).toBe(
      '<https://|a.test/?next=https://b.test/?t=1>',
    );
    expect(replaceUrlsInText('a://x b://y', mark)).toBe('<a://|x> <b://|y>');
    expect(replaceUrlsInText(`a://x${nbsp}y`, mark)).toBe(`<a://|x>${nbsp}y`);

    // 64 KiB each. The pattern takes seconds on these.
    const run = 'a.'.repeat(32 * 1024);
    unchangedInTime((text) => replaceUrlsInText(text, mark), [run, `${run}:// `]);
  });
});

describe("a feedback report's assignments", () => {
  // The pattern `replaceAssignments` replaced, and a callback that marks each
  // match's place and all five of its groups.
  const ASSIGNMENT =
    /(?<![\w.])([A-Za-z_][\w.-]*)(\s*=\s*)(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'`,;&]+))/g;
  const mark = (
    _m: string,
    key: string,
    eq: string,
    dq: string | undefined,
    sq: string | undefined,
    bare: string | undefined,
  ): string => `<${key}|${eq}|${dq}|${sq}|${bare}>`;

  test('are found where the pattern finds them, in time in step with the text', () => {
    for (const text of [
      'TOKEN=abc',
      'key = "v"',
      "key='v'",
      '--api-key=abc',
      'a-b=1',
      '1-b=1',
      '.b=1',
      'a.b=1',
      'k="open',
      'k=',
      'k\n=v',
      'a=1 b=2',
      'k="v"b=1',
      'k=v =1',
      'a=1b=2',
      `${String.fromCharCode(0xe9)}k=1`,
      'k = ',
      '_k=1',
      'k="a\nb"',
      'k  =  x',
    ]) {
      expect(replaceAssignments(text, mark), text).toBe(text.replace(ASSIGNMENT, mark));
    }
    expect(replaceAssignments('TOKEN=abc', mark)).toBe('<TOKEN|=|undefined|undefined|abc>');
    expect(replaceAssignments('--api-key=abc', mark)).toBe('--<api-key|=|undefined|undefined|abc>');
    expect(replaceAssignments('a-b=1', mark)).toBe('<a-b|=|undefined|undefined|1>');
    expect(replaceAssignments('1-b=1', mark)).toBe('1-<b|=|undefined|undefined|1>');
    expect(replaceAssignments('.b=1', mark)).toBe('.b=1');
    expect(replaceAssignments('a.b=1', mark)).toBe('<a.b|=|undefined|undefined|1>');
    expect(replaceAssignments('k="open', mark)).toBe('k="open');
    expect(replaceAssignments('k=', mark)).toBe('k=');
    expect(replaceAssignments('k\n=v', mark)).toBe('<k|\n=|undefined|undefined|v>');
    expect(replaceAssignments('a=1 b=2', mark)).toBe(
      '<a|=|undefined|undefined|1> <b|=|undefined|undefined|2>',
    );

    // 64 KiB. The pattern takes seconds on it.
    unchangedInTime((text) => replaceAssignments(text, mark), ['a-'.repeat(32 * 1024)]);
  });
});

describe("a feedback report's JWTs", () => {
  // The JWT shape `maskJwts` replaced.
  const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

  test('are masked where the pattern masks them, in time in step with the text', () => {
    const token = jwt(8, 8, 8);
    for (const text of [
      token,
      `sent ${token} back`,
      `a-${token}`,
      `x${token}`,
      `_${token}`,
      jwt(7, 8, 8),
      jwt(8, 8, 7),
      `eyJ-${token}`,
      `${token} and ${token}`,
      `xx.a-${token}`,
      `${token}.dddddddd`,
      `eyJ${'a'.repeat(8)}.eyJ${'b'.repeat(7)}.${jwt(8, 8, 8)}`,
    ]) {
      expect(maskJwts(text), text).toBe(text.replace(JWT, REDACTED));
    }
    expect(maskJwts(`sent ${token} back`)).toBe(`sent ${REDACTED} back`);
    expect(maskJwts(`a-${token}`)).toBe(`a-${REDACTED}`);
    expect(maskJwts(`x${token}`)).toBe(`x${token}`);
    expect(maskJwts(jwt(7, 8, 8))).toBe(jwt(7, 8, 8));
    expect(maskJwts(`eyJ-${token}`)).toBe(REDACTED);
    expect(maskJwts(`${token} and ${token}`)).toBe(`${REDACTED} and ${REDACTED}`);

    // 64 KiB. The pattern takes seconds on it.
    unchangedInTime(maskJwts, ['eyJ-'.repeat(16 * 1024)]);
  });
});

describe('a feedback report', () => {
  test('is masked as before, in time in step with its text', () => {
    expect(redactForSending('see 1.https://acme.test/cb?code=abc', ctx).text).toBe(
      'see 1.https://acme.test/cb?code=[redacted]',
    );
    expect(redactForSending('set x-ACME_TOKEN=abc123 then', ctx).text).toBe(
      'set x-ACME_TOKEN=[redacted] then',
    );
    expect(redactForSending(`sent a-${jwt(8, 8, 8)} back`, ctx).text).toBe(
      'sent a-[redacted] back',
    );

    // 64 KiB each. `_` isn't a URL scheme's character, so every other mask
    // takes time in step with these too, and the patterns `key=value`'s and
    // the JWT's masks replaced take seconds on them.
    unchangedInTime(
      (text) => redactForSending(text, ctx).text,
      ['_-'.repeat(32 * 1024), 'eyJ_-'.repeat(13 * 1024)],
    );
  });
});
