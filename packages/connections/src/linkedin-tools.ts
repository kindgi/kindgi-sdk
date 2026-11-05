// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/connections/linkedin/tools` — tools that act with a person's
 * LinkedIn connection, on their own profile: post, and delete a post. A
 * pack includes one by exporting it as a tool under an id the pack names:
 * a tool folder whose `index.ts` is
 * `export default linkedinPost({ id: 'acme.linkedin.post' })`.
 * The id is the pack's because a tool id is the tenant's, filed under the
 * first project that publishes it.
 */

import type { Tool, ToolContext } from '@kindgi/tools';

import { appFetch } from './app-fetch.js';
import { type AppToolOptions, appTool } from './app-tool.js';
import { linkedin } from './linkedin.js';
import { type ImageBytes, type PostImage, postImageSchema, readPostImages } from './posting.js';

export type { AppToolOptions } from './app-tool.js';
export type { PostImage } from './posting.js';

const POSTS_URL = 'https://api.linkedin.com/rest/posts';
const IMAGES_URL = 'https://api.linkedin.com/rest/images?action=initializeUpload';
/** Where LinkedIn takes an image's bytes: its `uploadUrl`s are on this host. */
const UPLOAD_HOST = 'www.linkedin.com';
/**
 * The version of LinkedIn's API the calls are written for (`YYYYMM`).
 * LinkedIn keeps each one at least a year after it comes out, and refuses
 * one it has retired, so this moves to a newer one within that year.
 */
const LINKEDIN_VERSION = '202610';
/** A member's id, as LinkedIn's ID token gives it (`sub`). */
const MEMBER_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A post's id, as LinkedIn's `x-restli-id` gives it. */
const POST_ID = /^urn:li:(share|ugcPost):[0-9]{1,32}$/;
/** An image's id, as LinkedIn's upload gives it. */
const IMAGE_ID = /^urn:li:image:[A-Za-z0-9_-]{1,128}$/;
/** LinkedIn's longest post. */
const TEXT_CHARS = 3_000;
/** The most images a post takes: LinkedIn's most in a multi-image post. */
const MOST_IMAGES = 20;
/** LinkedIn takes images of fewer pixels than this. */
const MOST_PIXELS = 36_152_320;
/** An image's longest alt text: LinkedIn takes fewer than 4,086 characters. */
const ALT_TEXT_CHARS = 4_085;
/** A link card's longest description: LinkedIn takes fewer than 4,086 characters. */
const DESCRIPTION_CHARS = 4_085;
/** A link card's longest title: LinkedIn takes fewer than 400 characters. */
const TITLE_CHARS = 399;
/** The image types LinkedIn takes. */
const IMAGE_TYPES: ReadonlySet<ImageBytes['type']> = new Set(['jpeg', 'gif', 'png']);
/** The headers of a call to LinkedIn's REST API. */
const REST_HEADERS = {
  'linkedin-version': LINKEDIN_VERSION,
  'x-restli-protocol-version': '2.0.0',
} as const;

export interface LinkedinPostInput {
  /**
   * Plain text, posted as written: a `#` that starts a word is a hashtag,
   * and nothing else is read as LinkedIn's markup (no mentions).
   */
  readonly text: string;
  /** Who sees it: anyone (the default), or the person's connections only. */
  readonly visibility?: 'public' | 'connections';
  /**
   * Images, 1 to 20 files the run may be shown, in order: JPEG, GIF or PNG,
   * each of fewer than 36,152,320 pixels. One is the post's image; two or
   * more make a multi-image post. With `link`, one at most: the card's
   * thumbnail.
   */
  readonly images?: readonly PostImage[];
  /** A link, shown as a card. LinkedIn makes no card from a link itself, so the card's title is given. */
  readonly link?: LinkedinPostLink;
}

/** A link card on a LinkedIn post. */
export interface LinkedinPostLink {
  /** An `https:` address. */
  readonly url: string;
  /** The card's title, under 400 characters. */
  readonly title: string;
  /** The card's words under its title, under 4,086 characters. */
  readonly description?: string;
}

export interface LinkedinPostOutput {
  /** The post's id: `urn:li:share:…` or `urn:li:ugcPost:…`. */
  readonly postId: string;
  /** Where the post is on LinkedIn. */
  readonly url: string;
}

const LINKEDIN_POST: Omit<Tool<LinkedinPostInput, LinkedinPostOutput>, 'id'> = {
  description:
    "Post on LinkedIn as the person (the LinkedIn account they connected), to their own feed: seen by anyone, or with `visibility: 'connections'` by their connections only. The text is posted as written, up to 3,000 characters: a # that starts a word is a hashtag, and LinkedIn's markup is escaped, so the text mentions no one. `images` adds 1 to 20 of the run's files (JPEG, GIF or PNG), each with its `altText`. `link` adds a card, with the `title` it shows (LinkedIn makes none itself) and one image at most as its thumbnail. A link in the text alone is clickable, with no card. In a run no person started, each post waits for that person's yes.",
  version: '1.1.0',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string', minLength: 1, maxLength: TEXT_CHARS, pattern: '\\S' },
      visibility: { type: 'string', enum: ['public', 'connections'] },
      images: {
        type: 'array',
        minItems: 1,
        maxItems: MOST_IMAGES,
        items: postImageSchema(ALT_TEXT_CHARS),
      },
      link: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'title'],
        properties: {
          url: { type: 'string', pattern: '^https://' },
          title: { type: 'string', minLength: 1, maxLength: TITLE_CHARS, pattern: '\\S' },
          description: { type: 'string', maxLength: DESCRIPTION_CHARS },
        },
      },
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
  network: { kind: 'allowlist', hosts: ['api.linkedin.com', UPLOAD_HOST] },
  needsSpec: {
    connections: {
      linkedin: { app: 'linkedin', permissions: ['posts.write'], as: 'person' },
    },
  },
  readsFiles: true,
  handler: async (input, ctx) => {
    // The input schema refuses these too; a handler called directly still mustn't post them.
    if (!/\S/.test(input.text) || [...input.text].length > TEXT_CHARS) {
      throw new Error(`The text is empty or longer than LinkedIn's ${TEXT_CHARS} characters.`);
    }
    const images = input.images ?? [];
    if (input.images !== undefined && (images.length === 0 || images.length > MOST_IMAGES)) {
      throw new Error(`A post takes 1 to ${MOST_IMAGES} images.`);
    }
    if (input.link !== undefined) checkLink(input.link, images.length);
    const member = ctx.connections?.linkedin?.account.id;
    if (member === undefined || !MEMBER_ID.test(member)) {
      throw new Error('This call has no LinkedIn connection with a member id to post as.');
    }
    const author = `urn:li:person:${member}`;
    const send = async (): Promise<LinkedinPostOutput> => {
      // Every image is read and checked before any leaves, then each is uploaded with the person as its owner.
      const read = await readPostImages(ctx, images);
      read.forEach(({ image }, i) => checkImage(image, images[i]?.file ?? ''));
      const ids: string[] = [];
      for (const { bytes } of read) ids.push(await uploadImage(ctx, author, bytes));
      const content = contentOf(input.link, images, ids);
      return createPost(ctx, {
        author,
        commentary: littleText(input.text),
        visibility: input.visibility === 'connections' ? 'CONNECTIONS' : 'PUBLIC',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        ...(content !== undefined && { content }),
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      });
    };
    // Posted once per call, uploads included: a step run again (resumed or retried) gets the first post's answer.
    return ctx.record !== undefined ? ctx.record('posted', send) : send();
  },
};

/** A tool, under the id the pack names, that posts on LinkedIn, with images or a link card if asked, as the person whose LinkedIn connection the call has. */
export function linkedinPost(options: AppToolOptions): Tool<LinkedinPostInput, LinkedinPostOutput> {
  return appTool(LINKEDIN_POST, options);
}

export interface LinkedinDeletePostInput {
  /** The post's id, as `linkedinPost` gives it: `urn:li:share:…` or `urn:li:ugcPost:…`. */
  readonly postId: string;
}

export interface LinkedinDeletePostOutput {
  /** It's gone from LinkedIn, whether this call or an earlier one deleted it. */
  readonly deleted: true;
}

const LINKEDIN_DELETE_POST: Omit<Tool<LinkedinDeletePostInput, LinkedinDeletePostOutput>, 'id'> = {
  description:
    "Delete a post the person (the LinkedIn account they connected) made on LinkedIn, by the `postId` that posting it gave. A post already deleted counts as deleted. In a run no person started, each delete waits for that person's yes.",
  version: '1.0.0',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['postId'],
    properties: { postId: { type: 'string', pattern: POST_ID.source } },
  },
  output: {
    type: 'object',
    additionalProperties: false,
    required: ['deleted'],
    properties: { deleted: { const: true } },
  },
  effects: [
    {
      kind: 'external-side-effect',
      resource: 'external:linkedin',
      notes: 'Deletes a post on LinkedIn as the person.',
    },
  ],
  mutating: true,
  // As a post: a delete as a person never goes out unasked in a run no person started.
  needsApprovalWhenUnattended: true,
  network: { kind: 'allowlist', hosts: ['api.linkedin.com'] },
  needsSpec: {
    connections: {
      linkedin: { app: 'linkedin', permissions: ['posts.write'], as: 'person' },
    },
  },
  handler: async (input, ctx) => {
    // The input schema refuses it too; a handler called directly still mustn't send it.
    if (!POST_ID.test(input.postId)) {
      throw new Error("That isn't a LinkedIn post id (urn:li:share:… or urn:li:ugcPost:…).");
    }
    const send = async (): Promise<LinkedinDeletePostOutput> => {
      const res = await appFetch(ctx, {
        entry: linkedin,
        connection: 'linkedin',
        toolId: 'linkedin.posts.delete',
        url: `${POSTS_URL}/${encodeURIComponent(input.postId)}`,
        method: 'DELETE',
        headers: { ...REST_HEADERS, 'x-restli-method': 'DELETE' },
      });
      if (res.status >= 500) {
        throw new Error(
          `LinkedIn may or may not have deleted it (${await linkedinSays(res)}): deleting it again is safe, since a deleted post counts as deleted.`,
        );
      }
      // LinkedIn answers 204 to a post it deleted before, too.
      if (res.status !== 204) {
        throw new Error(`LinkedIn didn't delete it: ${await linkedinSays(res)}`);
      }
      await res.body?.cancel();
      return { deleted: true };
    };
    return ctx.record !== undefined ? ctx.record('deleted', send) : send();
  },
};

/** A tool, under the id the pack names, that deletes a post the person made on LinkedIn, with their LinkedIn connection. */
export function linkedinDeletePost(
  options: AppToolOptions,
): Tool<LinkedinDeletePostInput, LinkedinDeletePostOutput> {
  return appTool(LINKEDIN_DELETE_POST, options);
}

/** A link card's checks, as the input schema has them, and its one image at most. */
function checkLink(link: LinkedinPostLink, images: number): void {
  let url: URL | undefined;
  try {
    url = new URL(link.url);
  } catch {
    url = undefined;
  }
  if (url?.protocol !== 'https:') throw new Error("The link's url isn't an https: address.");
  if (!/\S/.test(link.title) || [...link.title].length > TITLE_CHARS) {
    throw new Error(`The link's title is empty or ${TITLE_CHARS + 1} characters or longer.`);
  }
  if (images > 1) {
    throw new Error(
      'A link card takes one image at most, as its thumbnail: post the images without the link, or give one.',
    );
  }
}

/** Refuses an image LinkedIn doesn't take, before any is uploaded. */
function checkImage(image: ImageBytes | undefined, file: string): void {
  if (image === undefined || !IMAGE_TYPES.has(image.type)) {
    throw new Error(`The file ${file} isn't a JPEG, GIF or PNG image, so nothing was posted.`);
  }
  if (image.width * image.height >= MOST_PIXELS) {
    throw new Error(
      `The image ${file} is ${image.width} by ${image.height} pixels, and LinkedIn takes fewer than 36,152,320 in all, so nothing was posted.`,
    );
  }
}

/** Uploads one image as `owner`'s, and answers its id. */
async function uploadImage(
  ctx: Pick<ToolContext, 'connections' | 'abortSignal'>,
  owner: string,
  bytes: Uint8Array,
): Promise<string> {
  const start = await appFetch(ctx, {
    entry: linkedin,
    connection: 'linkedin',
    toolId: 'linkedin.images.initializeUpload',
    url: IMAGES_URL,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...REST_HEADERS },
    body: JSON.stringify({ initializeUploadRequest: { owner } }),
  });
  if (start.status !== 200) {
    throw new Error(
      `LinkedIn didn't take an image, so nothing was posted: ${await linkedinSays(start)}`,
    );
  }
  const value = jsonOf(await start.text())?.value as
    | { readonly uploadUrl?: unknown; readonly image?: unknown }
    | undefined;
  const image = value?.image;
  const uploadUrl = value?.uploadUrl;
  if (typeof image !== 'string' || !IMAGE_ID.test(image) || typeof uploadUrl !== 'string') {
    throw new Error(
      'LinkedIn started an image upload but gave no image id or upload address, so nothing was posted.',
    );
  }
  // The tool's network allows only LinkedIn's upload host: another would be a blocked call, so it's refused in words.
  let host: string | undefined;
  try {
    const url = new URL(uploadUrl);
    host = url.protocol === 'https:' ? url.host : undefined;
  } catch {
    host = undefined;
  }
  if (host !== UPLOAD_HOST) {
    throw new Error(
      `LinkedIn gave an upload address that isn't on https://${UPLOAD_HOST}, so nothing was posted.`,
    );
  }
  const put = await appFetch(ctx, {
    entry: linkedin,
    connection: 'linkedin',
    toolId: 'linkedin.images.upload',
    url: uploadUrl,
    method: 'PUT',
    body: bytes,
  });
  if (put.status !== 201 && put.status !== 200) {
    throw new Error(
      `LinkedIn didn't take an image's bytes, so nothing was posted: ${await linkedinSays(put)}`,
    );
  }
  await put.body?.cancel();
  return image;
}

/** The post's `content`: a link card, with its thumbnail; one image; or several. None for text alone. */
function contentOf(
  link: LinkedinPostLink | undefined,
  images: readonly PostImage[],
  ids: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  const media = ids.map((id, i) => {
    const altText = images[i]?.altText;
    return { id, ...(altText !== undefined && altText !== '' && { altText }) };
  });
  if (link !== undefined) {
    const thumbnail = media[0];
    return {
      article: {
        source: link.url,
        title: link.title,
        ...(link.description !== undefined &&
          link.description !== '' && { description: link.description }),
        ...(thumbnail !== undefined && { thumbnail: thumbnail.id }),
        ...(thumbnail?.altText !== undefined && { thumbnailAltText: thumbnail.altText }),
      },
    };
  }
  if (media.length === 1) return { media: media[0] };
  if (media.length > 1) return { multiImage: { images: media } };
  return undefined;
}

/** Posts `post`, once: a server error isn't tried again, and says so. */
async function createPost(
  ctx: Pick<ToolContext, 'connections' | 'abortSignal'>,
  post: Readonly<Record<string, unknown>>,
): Promise<LinkedinPostOutput> {
  const res = await appFetch(ctx, {
    entry: linkedin,
    connection: 'linkedin',
    // LinkedIn's own name for the call, whatever the pack's id: the entry's costs use it.
    toolId: 'linkedin.posts.create',
    url: POSTS_URL,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...REST_HEADERS },
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
  const e = jsonOf(await res.text());
  if (typeof e?.message === 'string') {
    return typeof e.code === 'string' ? `${e.code}: ${e.message}` : e.message;
  }
  // Not JSON, or no message: the status says enough.
  return `HTTP ${res.status}`;
}

/** `text` as a JSON object, else `undefined`. */
function jsonOf(text: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
