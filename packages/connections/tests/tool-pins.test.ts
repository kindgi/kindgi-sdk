// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import { type AnyTool, toManifest } from '@kindgi/tools';
import { describe, expect, it } from 'vitest';

import { githubIssuesAddLabels, githubIssuesList, githubLabelsList } from '../src/github-tools.js';
import { gmailSend } from '../src/google-tools.js';
import { linkedinPost } from '../src/linkedin-tools.js';
import { outlookMessageGet, outlookMessagesList, outlookSend } from '../src/microsoft-tools.js';

const TOOLS = {
  gmailSend,
  githubIssuesList,
  githubLabelsList,
  githubIssuesAddLabels,
  outlookSend,
  outlookMessagesList,
  outlookMessageGet,
  linkedinPost,
};

/**
 * Each tool's versions, each with a hash of what it declares (its manifest,
 * less the id its pack names). A server keeps the first manifest it's given
 * for a version, so a change published under the same version never reaches
 * a project that has that version already. Change a tool, bump its version,
 * then add a line here: never change one.
 */
const PINS: Record<keyof typeof TOOLS, Record<string, string>> = {
  gmailSend: { '1.0.0': '553a5e83ef39c6e25c1c8d95640e7ba6f2814318884181eeb3b1a4d634e2ada1' },
  githubIssuesList: { '1.0.0': '2e9a7f7d01f9aaa777df3cedf8374b5cdc3f7bb8b6d074f2a50ec08595916b98' },
  githubLabelsList: { '1.0.0': 'a9cd9f0fa4fc90fdf99eb42e3045f9544363d60beed12658aaf4c6f99a580fc9' },
  githubIssuesAddLabels: {
    '1.0.0': '16695bc00bd696e50c72fe9724c5ff2b790838d58056f80f4c58ee28a60f254c',
  },
  outlookSend: { '1.0.0': '880f0c0c96a56415630451dabcef11c7063172c62f3b607fd282f551b47cba7b' },
  outlookMessagesList: {
    '1.0.0': '60b02b54dbc3bd8b533b0208e8fad9f3dbe5b74e994da0b18d2a54ef77973861',
    '1.1.0': '4be0515b14c524185cd503241d64856a4e2b1cdf0184fee2b2de5e7f4dbcfdc4',
  },
  outlookMessageGet: {
    '1.0.0': '8f108ce8482dad5c396bb98a5fd31cb4fae748b5844440025e81716c9feee7ce',
    '1.1.0': 'e6b0cec491eebd8d33b4eaa44ea20fe73664e67e1257e78be2700d5f9ce4ff77',
  },
  linkedinPost: { '1.0.0': '67bff01e1b26f3bff67d26d4fb568285c797518bbe5dd762691479a389f2e2ca' },
};

/** JSON with each object's keys in order: the hash is of what's declared, not of the order it's written in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function declared(tool: AnyTool): string {
  const { id: _id, ...manifest } = toManifest(tool);
  return createHash('sha256').update(canonical(manifest)).digest('hex');
}

describe("each tool's version moves with what it declares", () => {
  it.each(Object.keys(TOOLS) as (keyof typeof TOOLS)[])('%s', (name) => {
    const tool = TOOLS[name]({ id: `acme.${name.toLowerCase()}` });
    expect(
      declared(tool),
      `${name} declares something new under ${tool.version}: bump its version, then add the new version and hash to PINS`,
    ).toBe(PINS[name][tool.version]);
  });
});
