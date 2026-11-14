// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
// reads-source: sdks/typescript/src/**/*.ts

/**
 * A `versions` that is still callable is deprecated on its call signature
 * alone, so an editor strikes through `policies.versions(id)` and not
 * `policies.versions.list`. The `@deprecated` tag sits on the call
 * signature of each versions client, and on neither the members beside it
 * nor the `versions` property of the client that holds it.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESOURCES = join(__dirname, '..', 'src', 'resources');

interface Callable {
  /** How a caller names its list, as the tag says it. */
  readonly list: string;
  readonly file: string;
  /** The client whose `versions` property it is. */
  readonly client: string;
  readonly versions: string;
  readonly members: readonly string[];
}

const CALLABLES: readonly Callable[] = [
  {
    list: 'flows.versions.list',
    file: 'flows.ts',
    client: 'FlowsClient',
    versions: 'FlowVersionsClient',
    members: ['list', 'get', 'unregister', 'reinstate'],
  },
  {
    list: 'policies.versions.list',
    file: 'policies.ts',
    client: 'PoliciesClient',
    versions: 'PolicyVersionsClient',
    members: ['list', 'get', 'unregister', 'reinstate'],
  },
  {
    list: 'schedules.versions.list',
    file: 'schedules.ts',
    client: 'SchedulesClient',
    versions: 'ScheduleVersionsClient',
    members: ['list', 'get'],
  },
  {
    list: 'webhooks.versions.list',
    file: 'webhooks.ts',
    client: 'WebhooksClient',
    versions: 'WebhookTriggerVersionsClient',
    members: ['list', 'get'],
  },
  {
    list: 'mailTriggers.versions.list',
    file: 'mail-triggers.ts',
    client: 'MailTriggersClient',
    versions: 'MailTriggerVersionsClient',
    members: ['list', 'get'],
  },
  {
    list: 'projects.queueRules.versions.list',
    file: 'expert-queue.ts',
    client: 'QueueRulesClient',
    versions: 'QueueRuleVersionsClient',
    members: ['list'],
  },
];

const parse = (text: string, file: string): ts.SourceFile =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

function deprecation(node: ts.Node): string | undefined {
  const tag = ts.getJSDocTags(node).find((t) => t.tagName.text === 'deprecated');
  return tag === undefined ? undefined : (ts.getTextOfJSDocComment(tag.comment) ?? '');
}

const memberName = (member: ts.TypeElement): string | undefined =>
  member.name !== undefined && ts.isIdentifier(member.name) ? member.name.text : undefined;

/** The call signature: one, deprecated, pointing at the list. */
function callProblems(versions: ts.InterfaceDeclaration, c: Callable): string[] {
  const calls = versions.members.filter(ts.isCallSignatureDeclaration);
  const problems = calls.length === 1 ? [] : [`${c.versions} has ${calls.length} call signatures`];
  for (const call of calls) {
    const text = deprecation(call);
    if (text === undefined) problems.push(`${c.versions}'s call signature has no @deprecated tag`);
    else if (!text.startsWith(`Use \`${c.list}\``)) {
      problems.push(`${c.versions}'s call signature says "${text}", not "Use \`${c.list}\`"`);
    }
  }
  return problems;
}

/** The members beside it: each there, none deprecated. */
function memberProblems(versions: ts.InterfaceDeclaration, c: Callable): string[] {
  return c.members.flatMap((name) => {
    const member = versions.members.find((m) => memberName(m) === name);
    if (member === undefined) return [`${c.versions} has no ${name}`];
    return deprecation(member) === undefined ? [] : [`${c.versions}.${name} is deprecated`];
  });
}

/** The client's `versions` property: of the versions client's type, not deprecated. */
function propertyProblems(client: ts.InterfaceDeclaration, c: Callable): string[] {
  const property = client.members.find((m) => memberName(m) === 'versions');
  if (property === undefined || !ts.isPropertySignature(property)) {
    return [`${c.client} has no versions property`];
  }
  const type = property.type;
  const typed =
    type !== undefined && ts.isTypeReferenceNode(type) && type.typeName.getText() === c.versions;
  return [
    ...(typed ? [] : [`${c.client}.versions isn't a ${c.versions}`]),
    ...(deprecation(property) === undefined ? [] : [`${c.client}.versions is deprecated`]),
  ];
}

/** What is wrong with where `c`'s tags sit in `source`; empty when nothing is. */
function misplaced(source: ts.SourceFile, c: Callable): string[] {
  const iface = (name: string) =>
    source.statements.find(
      (s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === name,
    );
  const versions = iface(c.versions);
  const client = iface(c.client);
  if (versions === undefined) return [`no interface ${c.versions}`];
  if (client === undefined) return [`no interface ${c.client}`];
  return [
    ...callProblems(versions, c),
    ...memberProblems(versions, c),
    ...propertyProblems(client, c),
  ];
}

describe('a callable versions is deprecated on its call signature alone', () => {
  it.each(CALLABLES)('$list', (c) => {
    const source = parse(readFileSync(join(RESOURCES, c.file), 'utf8'), c.file);
    expect(misplaced(source, c)).toEqual([]);
  });
});

describe('the check fails a tag in the wrong place', () => {
  const c: Callable = {
    list: 'things.versions.list',
    file: 'things.ts',
    client: 'ThingsClient',
    versions: 'ThingVersionsClient',
    members: ['list'],
  };
  const source = (parts: {
    readonly property?: string;
    readonly call?: string;
    readonly list?: string;
  }) =>
    parse(
      [
        'export interface ThingsClient {',
        `  /** ${parts.property ?? 'Its versions.'} */`,
        '  readonly versions: ThingVersionsClient;',
        '}',
        'export interface ThingVersionsClient {',
        `  /** ${parts.call ?? '@deprecated Use `things.versions.list`, which sends the same request.'} */`,
        '  (id: string): Promise<unknown>;',
        `  /** ${parts.list ?? 'The versions.'} */`,
        '  list(id: string): Promise<unknown>;',
        '}',
      ].join('\n'),
      c.file,
    );

  it('passes the right place', () => {
    expect(misplaced(source({}), c)).toEqual([]);
  });

  it('fails a tag on the property, as well as one missing from the call signature', () => {
    expect(
      misplaced(
        source({ property: '@deprecated Use `things.versions.list`.', call: 'Lists them.' }),
        c,
      ),
    ).toEqual([
      "ThingVersionsClient's call signature has no @deprecated tag",
      'ThingsClient.versions is deprecated',
    ]);
  });

  it('fails a tag on a member', () => {
    expect(misplaced(source({ list: '@deprecated Not this one.' }), c)).toEqual([
      'ThingVersionsClient.list is deprecated',
    ]);
  });

  it('fails a tag that points somewhere else', () => {
    expect(misplaced(source({ call: '@deprecated Use `things.list`.' }), c)).toEqual([
      'ThingVersionsClient\'s call signature says "Use `things.list`.", not "Use `things.versions.list`"',
    ]);
  });
});
