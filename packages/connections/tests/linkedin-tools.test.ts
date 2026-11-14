// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import {
  type FileReadAnswer,
  type FileStore,
  type ToolConnection,
  type ToolContext,
  invokeToolForTest,
  toManifest,
  toolContextForTest,
} from '@kindgi/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type LinkedinPostInput, linkedinDeletePost, linkedinPost } from '../src/linkedin-tools.js';

const TOKEN = 'AQXdSP.not-a-real-token';
const POSTS = 'https://api.linkedin.com/rest/posts';
const IMAGES = 'https://api.linkedin.com/rest/images?action=initializeUpload';
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
      version: '1.1.0',
      mutating: true,
      needsApprovalWhenUnattended: true,
      needsSpec: {
        connections: {
          linkedin: { app: 'linkedin', permissions: ['posts.write'], as: 'person' },
        },
      },
      network: { kind: 'allowlist', hosts: ['api.linkedin.com', 'www.linkedin.com'] },
      readsFiles: true,
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

/** A PNG's first bytes: its signature and `IHDR`, which say its size. */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

/** A JPEG's first bytes: an `APP0` segment, then the frame header that says its size. */
function jpeg(width: number, height: number): Uint8Array {
  const b = new Uint8Array(2 + 18 + 19);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
  b.set([0xff, 0xc2, 0, 17, 8], 20);
  const v = new DataView(b.buffer);
  v.setUint16(25, height);
  v.setUint16(27, width);
  return b;
}

/** A GIF's first bytes: its signature and logical screen. */
function gif(width: number, height: number): Uint8Array {
  const b = new Uint8Array(13);
  b.set([...'GIF89a'].map((c) => c.charCodeAt(0)));
  const v = new DataView(b.buffer);
  v.setUint16(6, width, true);
  v.setUint16(8, height, true);
  return b;
}

/** The run's files, by artifact id: bytes, or why a read gets none. */
function runFiles(byId: Readonly<Record<string, Uint8Array | FileReadAnswer>>): FileStore {
  return {
    read: async (id) => {
      const v = byId[id];
      if (v === undefined) return { notRead: 'rule' };
      return v instanceof Uint8Array ? { bytes: v } : v;
    },
  };
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/**
 * LinkedIn's image uploads and Posts API, stubbed: each upload starts
 * `urn:li:image:IMGn`, with its upload address on www.linkedin.com.
 */
function linkedinServing(
  answers: {
    readonly start?: (n: number) => Response;
    readonly upload?: () => Response;
    readonly post?: () => Response;
  } = {},
) {
  const calls: Call[] = [];
  let n = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body =
        typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : (init.body ?? null);
      calls.push({
        url,
        method: init.method ?? 'GET',
        headers: init.headers as Record<string, string>,
        body,
      });
      if (url === IMAGES) {
        n += 1;
        return (
          answers.start?.(n) ??
          Response.json({
            value: {
              uploadUrlExpiresAt: 1650567510704,
              uploadUrl: `https://www.linkedin.com/dms-uploads/IMG${n}/uploaded-image/0?ca=vector_ads&ut=x`,
              image: `urn:li:image:IMG${n}`,
            },
          })
        );
      }
      if (url.startsWith('https://www.linkedin.com/dms-uploads/')) {
        return answers.upload?.() ?? new Response(null, { status: 201 });
      }
      if (url === POSTS) {
        return (
          answers.post?.() ?? new Response(null, { status: 201, headers: { 'x-restli-id': SHARE } })
        );
      }
      return new Response('not stubbed', { status: 418 });
    }),
  );
  return calls;
}

const A = png(1200, 627);
const B = jpeg(1080, 1080);
const C = gif(400, 300);

describe('linkedin.post with images and a link', () => {
  it("uploads one image as the person's, with their token, then posts it with its alt text", async () => {
    const calls = linkedinServing();
    const r = await invokeToolForTest(
      post,
      { text: 'Our new office.', images: [{ file: 'art-a', altText: 'A bright room' }] },
      { connections: { linkedin: profile() }, files: runFiles({ 'art-a': A }) },
    );
    expect(r).toEqual({
      kind: 'ok',
      value: { postId: SHARE, url: `https://www.linkedin.com/feed/update/${SHARE}/` },
    });
    expect(calls.map((c) => `${c.method} ${c.url.split('?')[0]}`)).toEqual([
      'POST https://api.linkedin.com/rest/images',
      'PUT https://www.linkedin.com/dms-uploads/IMG1/uploaded-image/0',
      `POST ${POSTS}`,
    ]);
    expect(calls[0]?.body).toEqual({
      initializeUploadRequest: { owner: 'urn:li:person:782bbtaQ' },
    });
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      'x-restli-protocol-version': '2.0.0',
    });
    // The bytes go as they were stored, with the token as LinkedIn's upload asks.
    expect(calls[1]?.body).toBe(A);
    expect(calls[1]?.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect((calls[2]?.body as { content?: unknown }).content).toEqual({
      media: { id: 'urn:li:image:IMG1', altText: 'A bright room' },
    });
  });

  it('posts two or more images, in order, as a multi-image post', async () => {
    const calls = linkedinServing();
    const r = await invokeToolForTest(
      post,
      {
        text: 'Three views.',
        images: [{ file: 'art-a' }, { file: 'art-b', altText: 'The desk' }, { file: 'art-c' }],
      },
      {
        connections: { linkedin: profile() },
        files: runFiles({ 'art-a': A, 'art-b': B, 'art-c': C }),
      },
    );
    expect(r.kind).toBe('ok');
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([A, B, C]);
    expect((calls.at(-1)?.body as { content?: unknown }).content).toEqual({
      multiImage: {
        images: [
          { id: 'urn:li:image:IMG1' },
          { id: 'urn:li:image:IMG2', altText: 'The desk' },
          { id: 'urn:li:image:IMG3' },
        ],
      },
    });
  });

  it('a link is a card with the title it is given, and one image is its thumbnail', async () => {
    const calls = linkedinServing();
    const link = {
      url: 'https://acme.test/launch',
      title: 'We launched',
      description: 'What is new',
    };
    const card = await invokeToolForTest(
      post,
      { text: 'Read it here.', link },
      { connections: { linkedin: profile() } },
    );
    expect(card.kind).toBe('ok');
    expect(calls).toHaveLength(1);
    expect((calls[0]?.body as { content?: unknown }).content).toEqual({
      article: { source: link.url, title: link.title, description: link.description },
    });

    const withImage = await invokeToolForTest(
      post,
      { text: 'Read it here.', link, images: [{ file: 'art-a', altText: 'The launch' }] },
      { connections: { linkedin: profile() }, files: runFiles({ 'art-a': A }) },
    );
    expect(withImage.kind).toBe('ok');
    expect((calls.at(-1)?.body as { content?: unknown }).content).toEqual({
      article: {
        source: link.url,
        title: link.title,
        description: link.description,
        thumbnail: 'urn:li:image:IMG1',
        thumbnailAltText: 'The launch',
      },
    });
  });

  it('a link card with two images, an address that is not https:, or no title is refused before anything is sent', async () => {
    const calls = linkedinServing();
    const ctx = {
      connections: { linkedin: profile() },
      files: runFiles({ 'art-a': A, 'art-b': B }),
    };
    const two = await invokeToolForTest(
      post,
      {
        text: 'Read it.',
        link: { url: 'https://acme.test/', title: 'T' },
        images: [{ file: 'art-a' }, { file: 'art-b' }],
      },
      ctx,
    );
    expect(two.kind === 'err' && two.error.message).toContain('one image at most');
    for (const link of [
      { url: 'http://acme.test/', title: 'T' },
      { url: 'https://acme.test/' },
      { url: 'https://acme.test/', title: '  ' },
      { url: 'https://acme.test/', title: 'x'.repeat(400) },
    ]) {
      const r = await invokeToolForTest(post, { text: 'Read it.', link }, ctx);
      expect(r.kind === 'err' && r.error.code).toBe('input-validation-failed');
    }
    // The handler refuses them too when called without the schema in front of it.
    await expect(
      post.handler(
        { text: 'Read it.', link: { url: 'ftp://acme.test/', title: 'T' } },
        toolContextForTest(ctx),
      ),
    ).rejects.toThrow("isn't an https: address");
    expect(calls).toHaveLength(0);
  });

  it('none, or more than 20, images are refused by the input schema', async () => {
    const calls = linkedinServing();
    const files = runFiles({ 'art-a': A });
    for (const images of [[], Array.from({ length: 21 }, () => ({ file: 'art-a' }))]) {
      const r = await invokeToolForTest(
        post,
        { text: 'Many.', images },
        { connections: { linkedin: profile() }, files },
      );
      expect(r.kind === 'err' && r.error.code).toBe('input-validation-failed');
    }
    const twenty = await invokeToolForTest(
      post,
      { text: 'Many.', images: Array.from({ length: 20 }, () => ({ file: 'art-a' })) },
      { connections: { linkedin: profile() }, files },
    );
    expect(twenty.kind).toBe('ok');
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(20);
  });

  it('a file the run cannot read fails the call in words, and nothing is uploaded or posted', async () => {
    const calls = linkedinServing();
    const cases: [FileReadAnswer | undefined, string][] = [
      [undefined, "The file art-x isn't one this run may be shown, so nothing was posted."],
      [{ notRead: 'gone' }, 'The file art-x is gone: it was deleted, or its bytes are missing'],
      [{ notRead: 'changed' }, "The file art-x isn't the one that was checked when it was stored"],
      [{ notRead: 'size' }, "The file art-x is over its type's size limit"],
    ];
    for (const [answer, words] of cases) {
      const r = await invokeToolForTest(
        post,
        { text: 'Look.', images: [{ file: 'art-a' }, { file: 'art-x' }] },
        {
          connections: { linkedin: profile() },
          files: runFiles({ 'art-a': A, ...(answer !== undefined && { 'art-x': answer }) }),
        },
      );
      expect(r.kind === 'err' && r.error.message).toContain(words);
    }
    // A runtime that gives the call no file reads.
    const none = await invokeToolForTest(
      post,
      { text: 'Look.', images: [{ file: 'art-a' }] },
      { connections: { linkedin: profile() } },
    );
    expect(none.kind === 'err' && none.error.message).toContain(
      "no way to read the run's files, so nothing was posted",
    );
    expect(calls).toHaveLength(0);
  });

  it("an image LinkedIn doesn't take is refused before any is uploaded", async () => {
    const calls = linkedinServing();
    const pdf = new TextEncoder().encode('%PDF-1.7 not an image');
    const cases: [Uint8Array, string][] = [
      [pdf, "The file art-x isn't a JPEG, GIF or PNG image, so nothing was posted."],
      [png(0, 10), "isn't a JPEG, GIF or PNG image"],
      [new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]), "isn't a JPEG, GIF or PNG image"],
      [
        png(6016, 6010),
        'The image art-x is 6016 by 6010 pixels, and LinkedIn takes fewer than 36,152,320',
      ],
      [png(36_152_320, 1), 'The image art-x is 36152320 by 1 pixels'],
    ];
    for (const [bytes, words] of cases) {
      const r = await invokeToolForTest(
        post,
        { text: 'Look.', images: [{ file: 'art-a' }, { file: 'art-x' }] },
        { connections: { linkedin: profile() }, files: runFiles({ 'art-a': A, 'art-x': bytes }) },
      );
      expect(r.kind === 'err' && r.error.message).toContain(words);
    }
    expect(calls).toHaveLength(0);
    // One pixel under LinkedIn's limit is taken.
    const under = await invokeToolForTest(
      post,
      { text: 'Look.', images: [{ file: 'art-x' }] },
      { connections: { linkedin: profile() }, files: runFiles({ 'art-x': png(36_152_319, 1) }) },
    );
    expect(under.kind).toBe('ok');
    // So is a JPEG whose frame header comes after a fill byte and a marker with no length.
    const framed = new Uint8Array([
      ...[0xff, 0xd8, 0xff, 0xff, 0xe1, 0, 4, 0, 0, 0xff, 0xd0],
      ...[0xff, 0xc0, 0, 17, 8, 0x01, 0xe0, 0x02, 0x80, 3],
    ]);
    const late = await invokeToolForTest(
      post,
      { text: 'Look.', images: [{ file: 'art-x' }] },
      { connections: { linkedin: profile() }, files: runFiles({ 'art-x': framed }) },
    );
    expect(late.kind).toBe('ok');
  });

  it("an upload LinkedIn refuses, or an upload address off LinkedIn's upload host, posts nothing", async () => {
    const ctx = () => ({ connections: { linkedin: profile() }, files: runFiles({ 'art-a': A }) });
    const input = { text: 'Look.', images: [{ file: 'art-a' }] };

    let calls = linkedinServing({
      start: () =>
        Response.json({ status: 403, message: 'Not enough permissions' }, { status: 403 }),
    });
    let r = await invokeToolForTest(post, input, ctx());
    expect(r.kind === 'err' && r.error.message).toContain(
      "LinkedIn didn't take an image, so nothing was posted: Not enough permissions",
    );
    expect(calls).toHaveLength(1);

    for (const uploadUrl of [
      'https://uploads.example.com/dms-uploads/IMG1',
      'http://www.linkedin.com/dms-uploads/IMG1',
      'not a url',
    ]) {
      calls = linkedinServing({
        start: () => Response.json({ value: { uploadUrl, image: 'urn:li:image:IMG1' } }),
      });
      r = await invokeToolForTest(post, input, ctx());
      expect(r.kind === 'err' && r.error.message).toContain(
        "upload address that isn't on https://www.linkedin.com, so nothing was posted",
      );
      expect(calls).toHaveLength(1);
    }

    calls = linkedinServing({
      start: () => Response.json({ value: { image: 'urn:li:image:IMG1' } }),
    });
    r = await invokeToolForTest(post, input, ctx());
    expect(r.kind === 'err' && r.error.message).toContain('no image id or upload address');

    calls = linkedinServing({ upload: () => new Response('<html>no</html>', { status: 400 }) });
    r = await invokeToolForTest(post, input, ctx());
    expect(r.kind === 'err' && r.error.message).toContain(
      "LinkedIn didn't take an image's bytes, so nothing was posted: HTTP 400",
    );
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PUT']);
  });

  it("uploads once per call: a step run again gets the first post's answer, with no upload", async () => {
    const calls = linkedinServing();
    const journal = new Map<string, unknown>();
    const record: ToolContext['record'] = async (key, decide) => {
      if (!journal.has(key)) journal.set(key, await decide());
      return journal.get(key) as never;
    };
    const ctx = { connections: { linkedin: profile() }, files: runFiles({ 'art-a': A }), record };
    for (let i = 0; i < 2; i++) {
      const r = await invokeToolForTest(post, { text: 'Look.', images: [{ file: 'art-a' }] }, ctx);
      expect(r.kind).toBe('ok');
    }
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PUT', 'POST']);
  });
});

describe('linkedin.deletePost', () => {
  const del = linkedinDeletePost({ id: 'acme.linkedin.delete-post' });

  it("deletes as the person, asks before an unattended delete, and needs only that person's posts.write", () => {
    expect(del).toMatchObject({
      id: 'acme.linkedin.delete-post',
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
    expect(del.effects?.map((e) => e.kind)).toEqual(['external-side-effect']);
    expect(del.readsFiles).toBeUndefined();
  });

  it("deletes the post by its encoded id, with the person's token, and takes LinkedIn's 204 as done, again or not", async () => {
    const sent: Call[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        sent.push({
          url,
          method: init.method ?? 'GET',
          headers: init.headers as Record<string, string>,
          body: init.body ?? null,
        });
        return new Response(null, { status: 204 });
      }),
    );
    const ctx = { connections: { linkedin: profile() } };
    for (let i = 0; i < 2; i++) {
      expect(await invokeToolForTest(del, { postId: SHARE }, ctx)).toEqual({
        kind: 'ok',
        value: { deleted: true },
      });
    }
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      url: `${POSTS}/urn%3Ali%3Ashare%3A7254416297362735104`,
      method: 'DELETE',
      body: null,
    });
    expect(sent[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      'x-restli-protocol-version': '2.0.0',
      'x-restli-method': 'DELETE',
    });
    expect(sent[0]?.headers['linkedin-version']).toMatch(/^20[0-9]{2}(0[1-9]|1[0-2])$/);
  });

  it("LinkedIn's refusal comes back in its words, a server error says deleting again is safe, and an id that isn't a post's sends nothing", async () => {
    const ctx = { connections: { linkedin: profile() } };
    const answering = (res: () => Response) => {
      const sent: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          sent.push(url);
          return res();
        }),
      );
      return sent;
    };
    answering(() => Response.json({ status: 403, message: 'Not the author' }, { status: 403 }));
    const refused = await invokeToolForTest(del, { postId: SHARE }, ctx);
    expect(refused.kind === 'err' && refused.error.message).toContain(
      "LinkedIn didn't delete it: Not the author",
    );

    answering(() => Response.json({ message: 'Internal error' }, { status: 500 }));
    const unsure = await invokeToolForTest(del, { postId: SHARE }, ctx);
    expect(unsure.kind === 'err' && unsure.error.message).toContain(
      'LinkedIn may or may not have deleted it (Internal error): deleting it again is safe',
    );

    const sent = answering(() => new Response(null, { status: 204 }));
    for (const postId of ['urn:li:person:x', '7254416297362735104', 'urn:li:share:1/../x']) {
      const r = await invokeToolForTest(del, { postId }, ctx);
      expect(r.kind === 'err' && r.error.code).toBe('input-validation-failed');
    }
    await expect(
      del.handler({ postId: 'urn:li:image:x' }, toolContextForTest(ctx)),
    ).rejects.toThrow("isn't a LinkedIn post id");
    expect(sent).toHaveLength(0);
  });

  it("deletes once per call: a step run again gets the first delete's answer from its record", async () => {
    let sent = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        sent += 1;
        return new Response(null, { status: 204 });
      }),
    );
    const journal = new Map<string, unknown>();
    const record: ToolContext['record'] = async (key, decide) => {
      if (!journal.has(key)) journal.set(key, await decide());
      return journal.get(key) as never;
    };
    for (let i = 0; i < 2; i++) {
      const r = await invokeToolForTest(
        del,
        { postId: SHARE },
        { connections: { linkedin: profile() }, record },
      );
      expect(r.kind).toBe('ok');
    }
    expect(sent).toBe(1);
  });
});
