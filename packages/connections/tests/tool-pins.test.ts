// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  type AnyTool,
  type ToolManifest,
  changedToolFields,
  toManifest,
  toolDefinition,
} from '@kindgi/tools';
import { describe, expect, it } from 'vitest';

import { githubIssuesAddLabels, githubIssuesList, githubLabelsList } from '../src/github-tools.js';
import {
  gmailMessageGet,
  gmailMessagesList,
  gmailReply,
  gmailSend,
  googleCalendarEventCreate,
  googleCalendarEventUpdate,
  googleCalendarEventsList,
  googleCalendarFreeBusy,
} from '../src/google-tools.js';
import { linkedinPost } from '../src/linkedin-tools.js';
import {
  outlookCalendarEventCreate,
  outlookCalendarEventUpdate,
  outlookCalendarEventsList,
  outlookCalendarFreeBusy,
  outlookMessageGet,
  outlookMessagesList,
  outlookReply,
  outlookSend,
} from '../src/microsoft-tools.js';

/** Each tool as a pack includes it, and each mail tool for the company's mailbox too: `as` changes what it declares. */
const TOOLS = {
  gmailSend: (id: string) => gmailSend({ id }),
  'gmailSend as company': (id: string) => gmailSend({ id, as: 'company' }),
  gmailMessagesList: (id: string) => gmailMessagesList({ id }),
  'gmailMessagesList as company': (id: string) => gmailMessagesList({ id, as: 'company' }),
  gmailMessageGet: (id: string) => gmailMessageGet({ id }),
  'gmailMessageGet as company': (id: string) => gmailMessageGet({ id, as: 'company' }),
  gmailReply: (id: string) => gmailReply({ id }),
  'gmailReply as company': (id: string) => gmailReply({ id, as: 'company' }),
  githubIssuesList: (id: string) => githubIssuesList({ id }),
  githubLabelsList: (id: string) => githubLabelsList({ id }),
  githubIssuesAddLabels: (id: string) => githubIssuesAddLabels({ id }),
  outlookSend: (id: string) => outlookSend({ id }),
  'outlookSend as company': (id: string) => outlookSend({ id, as: 'company' }),
  outlookMessagesList: (id: string) => outlookMessagesList({ id }),
  'outlookMessagesList as company': (id: string) => outlookMessagesList({ id, as: 'company' }),
  outlookMessageGet: (id: string) => outlookMessageGet({ id }),
  'outlookMessageGet as company': (id: string) => outlookMessageGet({ id, as: 'company' }),
  outlookReply: (id: string) => outlookReply({ id }),
  'outlookReply as company': (id: string) => outlookReply({ id, as: 'company' }),
  linkedinPost: (id: string) => linkedinPost({ id }),
  googleCalendarEventsList: (id: string) => googleCalendarEventsList({ id }),
  'googleCalendarEventsList as company': (id: string) =>
    googleCalendarEventsList({ id, as: 'company' }),
  googleCalendarFreeBusy: (id: string) => googleCalendarFreeBusy({ id }),
  'googleCalendarFreeBusy as company': (id: string) =>
    googleCalendarFreeBusy({ id, as: 'company' }),
  googleCalendarEventCreate: (id: string) => googleCalendarEventCreate({ id }),
  'googleCalendarEventCreate as company': (id: string) =>
    googleCalendarEventCreate({ id, as: 'company' }),
  googleCalendarEventUpdate: (id: string) => googleCalendarEventUpdate({ id }),
  'googleCalendarEventUpdate as company': (id: string) =>
    googleCalendarEventUpdate({ id, as: 'company' }),
  outlookCalendarEventsList: (id: string) => outlookCalendarEventsList({ id }),
  'outlookCalendarEventsList as company': (id: string) =>
    outlookCalendarEventsList({ id, as: 'company' }),
  outlookCalendarFreeBusy: (id: string) => outlookCalendarFreeBusy({ id }),
  'outlookCalendarFreeBusy as company': (id: string) =>
    outlookCalendarFreeBusy({ id, as: 'company' }),
  outlookCalendarEventCreate: (id: string) => outlookCalendarEventCreate({ id }),
  'outlookCalendarEventCreate as company': (id: string) =>
    outlookCalendarEventCreate({ id, as: 'company' }),
  outlookCalendarEventUpdate: (id: string) => outlookCalendarEventUpdate({ id }),
  'outlookCalendarEventUpdate as company': (id: string) =>
    outlookCalendarEventUpdate({ id, as: 'company' }),
} satisfies Record<string, (id: string) => AnyTool>;

/**
 * Each tool's version and its definition at that version (`toolDefinition`,
 * what it declares), as JSON. A server keeps the first manifest it's given
 * for a version, and a deploy refuses the same version with another
 * definition, so a pack using a tool here could never redeploy after an
 * upgrade that changed the tool under the same version. Change a tool,
 * bump its version, then write its new version and definition here
 * (`KINDGI_WRITE_TOOL_PINS=1`, below). The write mode records only a
 * tool whose version moved.
 */
const PINS_FILE = fileURLToPath(new URL('./tool-definitions.json', import.meta.url));
type Pin = { readonly version: string; readonly definition: Readonly<Record<string, unknown>> };
const PINS = JSON.parse(readFileSync(PINS_FILE, 'utf8')) as Partial<
  Record<keyof typeof TOOLS, Pin>
>;
const WRITE = process.env.KINDGI_WRITE_TOOL_PINS === '1';

const BUMP =
  'A change a caller still works with (an optional input field, another effect or approval, a reworded description) is a minor bump (1.0.0 to 1.1.0), which an agent\'s "^1.0.0" takes. A change that breaks a caller (a required input field, an output field removed or retyped) is a major bump (2.0.0), and each agent that uses the tool needs a new pin.';

describe("each tool's version moves with what it declares", () => {
  it.each(Object.keys(TOOLS) as (keyof typeof TOOLS)[])('%s', (name) => {
    const tool = toManifest(TOOLS[name](`acme.${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`));
    const pin = PINS[name];
    if (pin?.version !== tool.version && WRITE) {
      PINS[name] = { version: tool.version, definition: toolDefinition(tool) };
      writeFileSync(PINS_FILE, `${JSON.stringify(PINS, null, 2)}\n`);
      return;
    }
    expect(
      pin?.version,
      `${name} is at version ${tool.version}, and tool-definitions.json pins ${pin?.version ?? 'none'}: write its new version and definition (KINDGI_WRITE_TOOL_PINS=1 pnpm --filter @kindgi/connections exec vitest run tests/tool-pins.test.ts)`,
    ).toBe(tool.version);
    const fields = changedToolFields(pin?.definition as unknown as ToolManifest, tool);
    expect(
      fields,
      `${name} declares something new under ${tool.version} (${fields.join(', ')}): give it a new version. ${BUMP}`,
    ).toEqual([]);
  });
});
