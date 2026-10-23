// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/connections/linkedin/tools` — tools that act with a person's
 * LinkedIn connection, on their own profile. A pack includes one by
 * exporting it as a tool under an id the pack names: a tool folder whose
 * `index.ts` is `export default linkedinPost({ id: 'acme.linkedin.post' })`.
 * The id is the pack's because a tool id is the tenant's, filed under the
 * first project that publishes it.
 */

import type { Tool } from '@kindgi/tools';

import { appFetch } from './app-fetch.js';
import { type AppToolOptions, appTool } from './app-tool.js';
import { linkedin } from './linkedin.js';

export type { AppToolOptions } from './app-tool.js';

const POSTS_URL = 'https://api.linkedin.com/rest/posts';
/**
 * The version of LinkedIn's API the calls are written for (`YYYYMM`).
 * LinkedIn keeps each one at least a year after it comes out, and refuses
 * one it has retired, so this moves to a newer one within that year.
 */
const LINKEDIN_VERSION = '202610';
/** A member's id, as LinkedIn's userinfo gives it (`sub`). */
const MEMBER_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A post's id, as LinkedIn's `x-restli-id` gives it. */
const POST_ID = /^urn:li:(share|ugcPost):[0-9]{1,32}$/;
/** LinkedIn's longest post. */
const TEXT_CHARS = 3_000;

export interface LinkedinPostInput {
  /**
   * Plain text, posted as written: a `#` that starts a word is a hashtag,
   * and nothing else is read as LinkedIn's markup (no mentions).
   */
  readonly text: string;
  /** Who sees it: anyone (the default), or the person's connections only. */
  readonly visibility?: 'public' | 'connections';
}

export interface LinkedinPostOutput {
  /** The post's id: `urn:li:share:…` or `urn:li:ugcPost:…`. */
  readonly postId: string;
  /** Where the post is on LinkedIn. */
  readonly url: string;
}

const LINKEDIN_POST: Omit<Tool<LinkedinPostInput, LinkedinPostOutput>, 'id'> = {
  description:
    "Post text on LinkedIn as the person (the LinkedIn account they connected), to their own feed: seen by anyone, or with `visibility: 'connections'` by their connections only. The text is posted as written, up to 3,000 characters: a # that starts a word is a hashtag, and LinkedIn's markup is escaped, so the text mentions no one. A link in the text is clickable, with no preview card. In a run no person started, each post waits for that person's yes.",
  version: '1.0.0',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string', minLength: 1, maxLength: TEXT_CHARS, pattern: '\\S' },
      visibility: { type: 'string', enum: ['public', 'connections'] },
    },
  },
  output: {
    type: 'object',
    additionalProperties: false,
    required: ['postId', 'url'],
    properties: { postId: { type: 'string' }, url: { type: 'string' } },
  },
  effects: [
    {
      kind: 'external-side-effect',
      resource: 'external:linkedin',
      notes: 'Posts on LinkedIn as the person.',
    },
    { kind: 'sensitive-data-egress', resource: 'external:linkedin' },
  ],
  mutating: true,
  // A post as a person never goes out unasked in a run a schedule, a webhook
  // or a service account's key started: the person says yes to each one.
  needsApprovalWhenUnattended: true,
  network: { kind: 'allowlist', hosts: ['api.linkedin.com'] },
  needsSpec: {
    connections: {
      linkedin: { app: 'linkedin', permissions: ['posts.write'], as: 'person' },
    },
  },
  handler: async (input, ctx) => {
    // The input schema refuses these too; a handler called directly still mustn't post them.
    if (!/\S/.test(input.text) || [...input.text].length > TEXT_CHARS) {
      throw new Error(`The text is empty or longer than LinkedIn's ${TEXT_CHARS} characters.`);
    }
    const member = ctx.connections?.linkedin?.account.id;
    if (member === undefined || !MEMBER_ID.test(member)) {
      throw new Error('This call has no LinkedIn connection with a member id to post as.');
    }
    const post = {
      author: `urn:li:person:${member}`,
      commentary: littleText(input.text),
      visibility: input.visibility === 'connections' ? 'CONNECTIONS' : 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };
    const send = async (): Promise<LinkedinPostOutput> => {
      const res = await appFetch(ctx, {
        entry: linkedin,
        connection: 'linkedin',
        // LinkedIn's own name for the call, whatever the pack's id: the entry's costs use it.
        toolId: 'linkedin.posts.create',
        url: POSTS_URL,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'linkedin-version': LINKEDIN_VERSION,
          'x-restli-protocol-version': '2.0.0',
        },
        body: JSON.stringify(post),
      });
      if (res.status >= 500) {
        // A post isn't tried again on a server error (appFetch's rule): LinkedIn may have made it.
        throw new Error(
          `LinkedIn may or may not have posted it (${await linkedinSays(res)}): look at the person's feed before posting it again.`,
        );
      }
      if (res.status !== 201) {
        throw new Error(`LinkedIn didn't post it: ${await linkedinSays(res)}`);
      }
      await res.body?.cancel();
      const postId = res.headers.get('x-restli-id');
      if (postId === null || !POST_ID.test(postId)) {
        throw new Error('LinkedIn posted it but gave no post id.');
      }
      return { postId, url: `https://www.linkedin.com/feed/update/${postId}/` };
    };
    // Posted once per call: a step run again (resumed or retried) gets the first post's answer.
    return ctx.record !== undefined ? ctx.record('posted', send) : send();
  },
};

/** A tool, under the id the pack names, that posts text on LinkedIn as the person whose LinkedIn connection the call has. */
export function linkedinPost(options: AppToolOptions): Tool<LinkedinPostInput, LinkedinPostOutput> {
  return appTool(LINKEDIN_POST, options);
}

/**
 * A `#` that starts a word, with its word (letters and digits, and the
 * marks some scripts' letters carry, with at least one letter, so `#1` is
 * text), or else one of the characters LinkedIn's post text ("little
 * text") reads as its markup: mentions, hashtags, templates.
 */
const LITTLE_TEXT =
  /(?<=^|\s)#((?=[\p{N}\p{M}]*\p{L})[\p{L}\p{N}][\p{L}\p{M}\p{N}]*)|[|{}@[\]()<>#\\*_~]/gu;

/**
 * Plain text as LinkedIn's post text: a `#` that starts a word is written
 * as LinkedIn's hashtag, `{hashtag|\#|word}`, and every other character it
 * reads as markup is escaped with a backslash, since a raw one can cut the
 * post's text short. So the text can mention no one: a mention,
 * `@[Name](urn:li:person:…)`, tells that member they were named.
 */
function littleText(text: string): string {
  return text.replace(LITTLE_TEXT, (c: string, word: string | undefined) =>
    word !== undefined ? `{hashtag|\\#|${word}}` : `\\${c}`,
  );
}

/** What LinkedIn's error says (its code and message), else the HTTP status. */
async function linkedinSays(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const e = JSON.parse(text) as { code?: unknown; message?: unknown };
    if (typeof e.message === 'string') {
      return typeof e.code === 'string' ? `${e.code}: ${e.message}` : e.message;
    }
  } catch {
    // Not JSON: the status says enough.
  }
  return `HTTP ${res.status}`;
}
