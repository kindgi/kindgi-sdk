// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import { type AnyTool, toManifest } from '@kindgi/tools';
import { describe, expect, it } from 'vitest';

import { githubIssuesAddLabels, githubIssuesList, githubLabelsList } from '../src/github-tools.js';
import { gmailMessageGet, gmailMessagesList, gmailSend } from '../src/google-tools.js';
import { linkedinPost } from '../src/linkedin-tools.js';
import { outlookMessageGet, outlookMessagesList, outlookSend } from '../src/microsoft-tools.js';

/** Each tool as a pack includes it, and each mail tool for the company's mailbox too: `as` changes what it declares. */
const TOOLS = {
  gmailSend: (id: string) => gmailSend({ id }),
  'gmailSend as company': (id: string) => gmailSend({ id, as: 'company' }),
  gmailMessagesList: (id: string) => gmailMessagesList({ id }),
  'gmailMessagesList as company': (id: string) => gmailMessagesList({ id, as: 'company' }),
  gmailMessageGet: (id: string) => gmailMessageGet({ id }),
  'gmailMessageGet as company': (id: string) => gmailMessageGet({ id, as: 'company' }),
  githubIssuesList: (id: string) => githubIssuesList({ id }),
  githubLabelsList: (id: string) => githubLabelsList({ id }),
  githubIssuesAddLabels: (id: string) => githubIssuesAddLabels({ id }),
  outlookSend: (id: string) => outlookSend({ id }),
  'outlookSend as company': (id: string) => outlookSend({ id, as: 'company' }),
  outlookMessagesList: (id: string) => outlookMessagesList({ id }),
  'outlookMessagesList as company': (id: string) => outlookMessagesList({ id, as: 'company' }),
  outlookMessageGet: (id: string) => outlookMessageGet({ id }),
  'outlookMessageGet as company': (id: string) => outlookMessageGet({ id, as: 'company' }),
  linkedinPost: (id: string) => linkedinPost({ id }),
} satisfies Record<string, (id: string) => AnyTool>;

/**
 * Each tool's versions, each with a hash of what it declares (its manifest,
 * less the id its pack names). A server keeps the first manifest it's given
 * for a version, so a change published under the same version never reaches
 * a project that has that version already. Change a tool, bump its version,
 * then add a line here: never change one.
 */
const PINS: Record<keyof typeof TOOLS, Record<string, string>> = {
  gmailSend: { '1.0.0': '553a5e83ef39c6e25c1c8d95640e7ba6f2814318884181eeb3b1a4d634e2ada1' },
  'gmailSend as company': {
    '1.0.0': '1ada941c76049cba0d64e5f391a28f81848b441bb5e27e262f1b6be4db1a0d3a',
  },
  gmailMessagesList: {
    '1.0.0': 'bd8b3e5886fecac4af9a6f1c98598acdf7cd687c98070b00890f211371f9fe58',
  },
  'gmailMessagesList as company': {
    '1.0.0': 'f6b6cb415803ac50ea2dc55b8f9c6c3d1ec16bbe112183e83d7f409c3e7e4ee6',
  },
  gmailMessageGet: {
    '1.0.0': 'a816d5447eae3b31df1715ded2c88c43d614c78d9acf73adf2a9d2e57fd12ef1',
  },
  'gmailMessageGet as company': {
    '1.0.0': '64fe253fe1f82004741b75aa48eae3d68183b40276c12ac50004ace5fa13af7a',
  },
  githubIssuesList: { '1.0.0': '2e9a7f7d01f9aaa777df3cedf8374b5cdc3f7bb8b6d074f2a50ec08595916b98' },
  githubLabelsList: { '1.0.0': 'a9cd9f0fa4fc90fdf99eb42e3045f9544363d60beed12658aaf4c6f99a580fc9' },
  githubIssuesAddLabels: {
    '1.0.0': '16695bc00bd696e50c72fe9724c5ff2b790838d58056f80f4c58ee28a60f254c',
  },
  outlookSend: { '1.0.0': '880f0c0c96a56415630451dabcef11c7063172c62f3b607fd282f551b47cba7b' },
  'outlookSend as company': {
    '1.0.0': '19cf1fb8f398284be781d9e5b1a5e8456ae736433c3887fa11f614f9121805d3',
  },
  outlookMessagesList: {
    '1.0.0': '60b02b54dbc3bd8b533b0208e8fad9f3dbe5b74e994da0b18d2a54ef77973861',
  },
  'outlookMessagesList as company': {
    '1.0.0': '617d175890f74d86b04038ddac9c5fde82eb440fa143c69bd2600587c6dce09f',
  },
  outlookMessageGet: {
    '1.0.0': '8f108ce8482dad5c396bb98a5fd31cb4fae748b5844440025e81716c9feee7ce',
    '2.0.0': 'f8b57988808ea35db8bf9de25653796552b7dce657ed829e600fc546e5b4aaf3',
  },
  'outlookMessageGet as company': {
    '2.0.0': '350011bf4dd8a675f008dd72d7102033a5e07d946497c8ca58eb04bea30cfe21',
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
    const tool = TOOLS[name](`acme.${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
    expect(
      declared(tool),
      `${name} declares something new under ${tool.version}: bump its version, then add the new version and hash to PINS`,
    ).toBe(PINS[name][tool.version]);
  });
});
