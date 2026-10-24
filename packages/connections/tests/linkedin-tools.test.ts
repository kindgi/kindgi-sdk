// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import {
  type ToolConnection,
  type ToolContext,
  invokeToolForTest,
  toManifest,
  toolContextForTest,
} from '@kindgi/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type LinkedinPostInput, linkedinPost } from '../src/linkedin-tools.js';

const TOKEN = 'AQXdSP.not-a-real-token';
const POSTS = 'https://api.linkedin.com/rest/posts';
const SHARE = 'urn:li:share:7254416297362735104';

const post = linkedinPost({ id: 'acme.linkedin.post' });

function profile(id = '782bbtaQ'): ToolConnection {
  return {
    connectionId: randomUUID(),
    app: 'linkedin',
    appName: 'LinkedIn',
    accessToken: TOKEN,
    account: { id, label: 'ana@acme.test' },
  };
}

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: { readonly commentary?: string; readonly [field: string]: unknown };
}

/** LinkedIn's Posts API, stubbed: what each call sent. */
function linkedinAnswering(
  answer: () => Response = () =>
    new Response(null, { status: 201, headers: { 'x-restli-id': SHARE } }),
) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({
        url,
        method: init.method ?? 'GET',
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
      });
      return answer();
    }),
  );
  return sent;
}

const POST: LinkedinPostInput = { text: 'We shipped connections today.' };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('linkedin.post', () => {
  it("posts as the person, asks before an unattended post, and needs only that person's posts.write", () => {
    expect(post).toMatchObject({
      id: 'acme.linkedin.post',
      version: '1.0.0',
      mutating: true,
      needsApprovalWhenUnattended: true,
      needsSpec: {
        connections: {
          linkedin: { app: 'linkedin', permissions: ['posts.write'], as: 'person' },
        },
      },
      network: { kind: 'allowlist', hosts: ['api.linkedin.com'] },
    });
    expect(post.effects?.map((e) => e.kind)).toEqual([
      'external-side-effect',
      'sensitive-data-egress',
    ]);
  });

  it('is the tool under the id its pack names: two ids, two tools alike but for the id', () => {
    const other = linkedinPost({ id: 'beta.social.post' });
    expect(other.id).toBe('beta.social.post');
    expect({ ...toManifest(other), id: post.id }).toEqual(toManifest(post));
    expect(() => linkedinPost({ id: '' })).toThrow('The tool "" failed to compile');
  });

  it("posts to the person's own feed with their token and LinkedIn's version, and says where the post is", async () => {
    const sent = linkedinAnswering();
    const r = await invokeToolForTest(post, POST, { connections: { linkedin: profile() } });
    expect(r).toEqual({
      kind: 'ok',
      value: { postId: SHARE, url: `https://www.linkedin.com/feed/update/${SHARE}/` },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: POSTS, method: 'POST' });
    expect(sent[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'x-restli-protocol-version': '2.0.0',
    });
    expect(sent[0]?.headers['linkedin-version']).toMatch(/^20[0-9]{2}(0[1-9]|1[0-2])$/);
    // The author is always the connected member: the input can't name another.
    expect(sent[0]?.body).toEqual({
      author: 'urn:li:person:782bbtaQ',
      commentary: 'We shipped connections today.',
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
  });

  it("posts to the person's connections only when asked", async () => {
    const sent = linkedinAnswering();
    const r = await invokeToolForTest(
      post,
      { ...POST, visibility: 'connections' },
      { connections: { linkedin: profile() } },
    );
    expect(r.kind).toBe('ok');
    expect(sent[0]?.body.visibility).toBe('CONNECTIONS');
  });

  it('posts the text as written: a # that starts a word is a hashtag, and the rest of the markup is escaped, so it mentions no one', async () => {
    const sent = linkedinAnswering();
    const cases: [string, string][] = [
      ['Hello @[Bo Lee](urn:li:person:abc123)', 'Hello \\@\\[Bo Lee\\]\\(urn:li:person:abc123\\)'],
      ['{hashtag|\\#|kindgi}', '\\{hashtag\\|\\\\\\#\\|kindgi\\}'],
      ['<b>*bold*</b> _x_ ~y~', '\\<b\\>\\*bold\\*\\</b\\> \\_x\\_ \\~y\\~'],
      ['Ship it #agents #1 and #día', 'Ship it {hashtag|\\#|agents} \\#1 and {hashtag|\\#|día}'],
      ['#launch day', '{hashtag|\\#|launch} day'],
      ['We are #1, #2026plans', 'We are \\#1, {hashtag|\\#|2026plans}'],
      [
        '#ai, #ml. #foo_bar #हिन्दी',
        '{hashtag|\\#|ai}, {hashtag|\\#|ml}. {hashtag|\\#|foo}\\_bar {hashtag|\\#|हिन्दी}',
      ],
      ['C# and F#, # alone, a#b, #', 'C\\# and F\\#, \\# alone, a\\#b, \\#'],
      ['Line one\n#two', 'Line one\n{hashtag|\\#|two}'],
    ];
    for (const [text, commentary] of cases) {
      const r = await invokeToolForTest(post, { text }, { connections: { linkedin: profile() } });
      expect(r.kind).toBe('ok');
      expect(sent.at(-1)?.body.commentary).toBe(commentary);
    }
  });

  it('empty, blank or over-long text is refused before anything is posted', async () => {
    const sent = linkedinAnswering();
    for (const text of ['', '   \n\t', 'x'.repeat(3_001)]) {
      const r = await invokeToolForTest(post, { text }, { connections: { linkedin: profile() } });
      expect(r.kind === 'err' && r.error.code).toBe('input-validation-failed');
    }
    // 3,000 characters, counted as people see them: an emoji is one.
    expect(
      (
        await invokeToolForTest(
          post,
          { text: '🙂'.repeat(3_000) },
          { connections: { linkedin: profile() } },
        )
      ).kind,
    ).toBe('ok');
    // The handler refuses them too when called without the schema in front of it.
    await expect(
      post.handler({ text: ' ' }, toolContextForTest({ connections: { linkedin: profile() } })),
    ).rejects.toThrow('empty or longer');
    expect(sent).toHaveLength(1);
  });

  it('a connection without a member id LinkedIn could have given posts nothing', async () => {
    const sent = linkedinAnswering();
    for (const id of ['', 'urn:li:person:x', 'a b', 'x'.repeat(65)]) {
      const r = await invokeToolForTest(post, POST, { connections: { linkedin: profile(id) } });
      expect(r.kind === 'err' && r.error.message).toContain('no LinkedIn connection');
    }
    expect(sent).toHaveLength(0);
  });

  it("LinkedIn's refusal comes back in its words, never with the token; only a 201 with a post id is taken as posted", async () => {
    linkedinAnswering(() =>
      Response.json(
        {
          status: 422,
          code: 'UNPROCESSABLE_ENTITY',
          message: 'Content is a duplicate of urn:li:share:7254416297362735104',
        },
        { status: 422 },
      ),
    );
    const r = await invokeToolForTest(post, POST, { connections: { linkedin: profile() } });
    expect(r.kind === 'err' && r.error.code).toBe('handler-error');
    const message = r.kind === 'err' ? r.error.message : '';
    expect(message).toContain(
      "LinkedIn didn't post it: UNPROCESSABLE_ENTITY: Content is a duplicate of urn:li:share:7254416297362735104",
    );
    expect(message).not.toContain(TOKEN);

    linkedinAnswering(() => new Response('<html>busy</html>', { status: 400 }));
    const plain = await invokeToolForTest(post, POST, { connections: { linkedin: profile() } });
    expect(plain.kind === 'err' && plain.error.message).toContain(
      "LinkedIn didn't post it: HTTP 400",
    );

    linkedinAnswering(() =>
      Response.json({ status: 504, message: 'Gateway timed out' }, { status: 504 }),
    );
    const unsure = await invokeToolForTest(post, POST, { connections: { linkedin: profile() } });
    expect(unsure.kind === 'err' && unsure.error.message).toContain(
      "LinkedIn may or may not have posted it (Gateway timed out): look at the person's feed before posting it again.",
    );

    for (const answer of [
      () => Response.json({}, { status: 200 }),
      () => new Response(null, { status: 201 }),
      () => new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:person:x' } }),
    ]) {
      linkedinAnswering(answer);
      const odd = await invokeToolForTest(post, POST, { connections: { linkedin: profile() } });
      expect(odd.kind).toBe('err');
    }
  });

  it("under any id, a post is charged as LinkedIn's: 150 a day on a connection, then the next waits its turn", async () => {
    vi.useFakeTimers();
    const sent = linkedinAnswering();
    const ctx = { connections: { linkedin: profile() } };
    for (let i = 0; i < 150; i++) {
      expect((await invokeToolForTest(post, POST, ctx)).kind).toBe('ok');
    }
    expect(sent).toHaveLength(150);
    const other = linkedinPost({ id: 'beta.social.post' });
    const next = invokeToolForTest(other, POST, ctx);
    // A day's 150 come back one every 576 s.
    await vi.advanceTimersByTimeAsync(575_999);
    expect(sent).toHaveLength(150);
    await vi.advanceTimersByTimeAsync(1);
    expect((await next).kind).toBe('ok');
    expect(sent).toHaveLength(151);
  });

  it("posts once per call: a step run again gets the first post's answer from its record", async () => {
    const sent = linkedinAnswering();
    const journal = new Map<string, unknown>();
    const record: ToolContext['record'] = async (key, decide) => {
      if (!journal.has(key)) journal.set(key, await decide());
      return journal.get(key) as never;
    };
    const ctx = { connections: { linkedin: profile() }, record };
    for (let i = 0; i < 2; i++) {
      expect(await invokeToolForTest(post, POST, ctx)).toEqual({
        kind: 'ok',
        value: { postId: SHARE, url: `https://www.linkedin.com/feed/update/${SHARE}/` },
      });
    }
    expect(sent).toHaveLength(1);
  });
});
