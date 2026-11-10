// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
// reads-source: packages/api/src/**

/**
 * The plan limits' writers sweep. A write in packages/api/src that can add
 * a flow or an agent to production (a flow or agent version published or
 * reinstated, a deployment registered or promoted, a project put in
 * production) asks the plan limits first: it runs inside the write an
 * `admitPlan(…)` or a binding's `admit(…)` is given, or inside a function
 * every caller of which does, up to one that is. Each write is named in
 * `WRITERS` with the writer it is part of, or in `OTHER_KINDS` with what it
 * writes instead, so a new one is a choice made here; and one reached
 * outside the plan limits fails, until it asks or is named in `UNCOUNTED`
 * with why it adds nothing.
 *
 * It reads the source with TypeScript's parser, by name: a write is a
 * binding method (`WRITE_METHODS`) read off anything, and a function's
 * callers are the names that call it in its scope, or in the files that
 * import it. The route tests show each writer's answers.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** The binding methods a flow or agent version, a deployment, or production is written by. */
const WRITE_METHODS = new Set([
  'publish',
  'register',
  'reinstate',
  'reinstateVersion',
  'promote',
  'setProduction',
]);

/** Each write that can add a flow or an agent to production, and the writer it is part of. */
const WRITERS: Readonly<Record<string, string>> = {
  'routes/agents.ts: agentsRouter: binding.publish': 'publish',
  'routes/flows.ts: flowsRouter: binding.publish': 'publish',
  'routes/agents.ts: agentsRouter: binding.reinstateVersion': 'reinstate',
  'routes/flows.ts: flowsRouter: binding.reinstateVersion': 'reinstate',
  'routes/deployments.ts: registerAgents: agents.publish': 'deploy',
  'routes/deployments.ts: registerAgents: agents.reinstateVersion': 'deploy',
  'routes/deployments.ts: registerFlows: flows.publish': 'deploy',
  'routes/deployments.ts: registerFlows: flows.reinstateVersion': 'deploy',
  'routes/deployments.ts: reinstateRetiredVersion: input.reinstate': 'deploy',
  'routes/deployments.ts: registerDeployment: bindings.deploymentRegistry.register': 'deploy',
  'agent-pins.ts: publishDeployedAgent: agents.publish': 'deploy',
  'flow-pins.ts: publishDeployedFlow: flows.publish': 'deploy',
  'deploy-versions.ts: deployVersion: input.publish': 'deploy',
  'deploy-versions.ts: registerNextFree: input.publish': 'deploy',
  'routes/deployment-promotions.ts: mountDeploymentPromotions: bindings.deploymentRegistry.promote':
    'promote',
  'routes/project-production.ts: projectProductionRouter: projects.setProduction': 'go live',
  'derive-agent-version.ts: publishFirstFree: agents.publish': 'a suggested change',
};

/** The writes of other kinds, and what each writes: none is a flow, an agent or a deployment. */
const OTHER_KINDS: Readonly<Record<string, string>> = {
  'block-publish.ts: publishBlockEdit: blocks.publish': 'a data block',
  'deploy-blocks.ts: publishPackBlocks: blocks.publish': 'a data block',
  'routes/blocks.ts: blocksRouter: binding.publish': 'a data block',
  'routes/blocks.ts: blocksRouter: binding.reinstateVersion': 'a data block',
  'routes/deployments.ts: writePrimitives: bindings.toolRegistry.publish': 'a tool',
  'routes/deployments.ts: reinstateRetiredTool: registry.reinstateVersion': 'a tool',
  'routes/tools.ts: toolsRouter: binding.publish': 'a tool',
  'routes/tools.ts: toolsRouter: binding.reinstateVersion': 'a tool',
  'routes/deployments.ts: writePrimitives: bindings.guardrailRegistry.register': 'a guardrail',
  'routes/deployments.ts: keepRegisteredGuardrail: registry.register': 'a guardrail',
  'routes/guardrails.ts: guardrailsRouter: binding.register': 'a guardrail',
  'routes/policies.ts: policiesRouter: binding.publish': 'a policy',
  'routes/policies.ts: policiesRouter: binding.reinstateVersion': 'a policy',
  'routes/release-gates.ts: releaseGatesRouter: binding.publish': 'a release gate',
  'routes/test-sets.ts: testSetsRouter: binding.publish': 'a test set',
  'routes/test-sets.ts: testSetsRouter: binding.reinstateVersion': 'a test set',
  'test-set-freeze.ts: publish: testSets.publish': 'a test set',
  'routes/event-triggers.ts: eventTriggersRouter: binding.register': 'an event trigger',
  'routes/mail-triggers.ts: mailTriggersRouter: binding.register': 'a mail trigger',
  'routes/schedules.ts: schedulesRouter: binding.register': 'a schedule',
  'routes/webhooks.ts: webhooksRouter: binding.register': 'a webhook',
  'routes/providers.ts: providersRouter: binding.register': 'a model provider',
  'routes/reviewers.ts: reviewersRouter: binding.register': 'a reviewer',
  'routes/sites.ts: sitesRouter: binding.register': 'a site',
  'routes/mcp.ts: mcpRouter: binding.register': 'an MCP endpoint',
  'mcp-server/endpoint.ts: mountMcpServer: set.register': "an MCP server's tools, per request",
  'routes/auth.ts: authRouter: identityProvider.register': 'an identity provider',
};

/** The places a write is reached outside the plan limits, each one site in the source, and why it adds nothing. */
const UNCOUNTED: Readonly<Record<string, string>> = {
  'routes/deployments.ts: deploymentsRouter: writeDeploy':
    'a deploy with no project: its pack has no agents, flows, tools or guardrails, or the app has no projects',
  'routes/agents.ts: agentsRouter: binding.reinstateVersion':
    'reinstating a version that is not retired: it counts already',
  'routes/flows.ts: flowsRouter: binding.reinstateVersion':
    'reinstating a version that is not retired: it counts already',
  'derive-agent-version.ts: publishNextFree: publish': 'no plan-limits binding: nothing is counted',
};

interface Sweep {
  /** Every write found, as `<file>: <function>: <receiver>.<method>`. */
  readonly writes: readonly string[];
  /** Each way a write of `WRITERS` is reached outside the plan limits: its sites, from the write up. */
  readonly unasked: readonly string[];
  /** How many sites in the source each `UNCOUNTED` place matched. */
  readonly uncounted: Readonly<Record<string, number>>;
}

/** The sweep over `sources` (path relative to src → its text). */
function sweep(
  sources: ReadonlyMap<string, string>,
  writers: Readonly<Record<string, string>>,
  uncounted: Readonly<Record<string, string>>,
): Sweep {
  const files = new Map(
    [...sources].map(([file, text]) => [
      file,
      ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    ]),
  );
  const matched = new Map(Object.keys(uncounted).map((place) => [place, new Set<number>()]));

  const unasked = (node: ts.Node, seen: ReadonlySet<ts.Node>): string[][] => {
    if (insideAdmit(node)) return [];
    const place = siteOf(node);
    const sites = matched.get(place);
    if (sites !== undefined) {
      sites.add(node.getStart());
      return [];
    }
    const fn = enclosingFunction(node);
    if (fn === undefined) return [[place, 'nothing in src calls it']];
    const name = nameOf(fn);
    if (name === undefined) {
      return [[place, `in a method, ${(fn as ts.MethodDeclaration).name.getText()}`]];
    }
    if (seen.has(fn)) return [];
    const callers = callersOf(files, fn, name);
    if (callers.length === 0) return [[place, `nothing in src calls ${name}`]];
    const next = new Set(seen).add(fn);
    return callers
      .flatMap(usesOf)
      .flatMap((caller) => unasked(caller, next).map((chain) => [place, ...chain]));
  };

  const writes = new Set<string>();
  const chains: string[] = [];
  for (const file of files.values()) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        WRITE_METHODS.has(node.name.text) &&
        usesOf(node).length > 0
      ) {
        const write = siteOf(node);
        writes.add(write);
        if (write in writers) {
          for (const use of usesOf(node)) {
            chains.push(...unasked(use, new Set()).map((chain) => chain.join(' ← ')));
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return {
    writes: [...writes].sort(),
    unasked: [...new Set(chains)].sort(),
    uncounted: Object.fromEntries([...matched].map(([place, sites]) => [place, sites.size])),
  };
}

type Fn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;

/** A function's own name: a declaration's, or the variable's it is the value of. */
function nameOf(fn: Fn): string | undefined {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text;
  if (ts.isMethodDeclaration(fn)) return undefined;
  return ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)
    ? fn.parent.name.text
    : undefined;
}

/** The nearest named function (or method) around `node`: an unnamed one, like a route's handler, is passed through. */
function enclosingFunction(node: ts.Node): Fn | undefined {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (
      (ts.isFunctionDeclaration(at) || ts.isArrowFunction(at) || ts.isFunctionExpression(at)) &&
      nameOf(at) !== undefined
    ) {
      return at;
    }
    if (ts.isMethodDeclaration(at)) return at;
  }
  return undefined;
}

/** `<file>: <function>: <expression>` for a node. */
function siteOf(node: ts.Node): string {
  const fn = enclosingFunction(node);
  const owner =
    fn === undefined ? '(top)' : (nameOf(fn) ?? `${(fn as ts.MethodDeclaration).name.getText()}()`);
  return `${node.getSourceFile().fileName}: ${owner}: ${node.getText().replace(/\s+/g, '')}`;
}

/**
 * Whether `node` is, or is inside, the write a plan-limits admit runs:
 * `admitPlan`'s fourth argument, or an `admit`'s second, given as a
 * function or by its name.
 */
function insideAdmit(node: ts.Node): boolean {
  for (let at: ts.Node = node; at.parent !== undefined; at = at.parent) {
    const call = at.parent;
    if (!ts.isCallExpression(call)) continue;
    const callee = call.expression;
    const write =
      ts.isIdentifier(callee) && callee.text === 'admitPlan'
        ? 3
        : ts.isPropertyAccessExpression(callee) && callee.name.text === 'admit'
          ? 1
          : -1;
    if (
      write >= 0 &&
      call.arguments.indexOf(at as ts.Expression) === write &&
      (ts.isIdentifier(at) || ts.isArrowFunction(at) || ts.isFunctionExpression(at))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Where a found write or caller is used: a presence check
 * (`x.promote === undefined`) writes nothing, and a name it is kept in
 * (`const promote = x.promote`) is followed to that name's uses.
 */
function usesOf(node: ts.Node): ts.Node[] {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && isPresenceCheck(parent, node)) return [];
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === node &&
    ts.isIdentifier(parent.name)
  ) {
    return namesIn(scopeOf(parent), parent.name.text, parent.name).flatMap(usesOf);
  }
  return [node];
}

function isPresenceCheck(check: ts.BinaryExpression, node: ts.Node): boolean {
  const equality = [
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
  ];
  if (!equality.includes(check.operatorToken.kind)) return false;
  const other = check.left === node ? check.right : check.left;
  return (
    (ts.isIdentifier(other) && other.text === 'undefined') ||
    other.kind === ts.SyntaxKind.NullKeyword
  );
}

/** The block (or file) a declaration's name is seen in. */
function scopeOf(declaration: ts.Node): ts.Node {
  for (let at = declaration.parent; at !== undefined; at = at.parent) {
    if (ts.isBlock(at) || ts.isSourceFile(at)) return at;
  }
  return declaration.getSourceFile();
}

/** Each use of the name `name` under `root`: not a declaration, a property's name, an import or an export. */
function namesIn(root: ts.Node, name: string, declared?: ts.Node): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name && node !== declared && !isNameOnly(node)) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function isNameOnly(id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    (ts.isPropertyAccessExpression(p) && p.name === id) ||
    (ts.isPropertyAssignment(p) && p.name === id) ||
    (ts.isMethodDeclaration(p) && p.name === id) ||
    (ts.isPropertySignature(p) && p.name === id) ||
    (ts.isBindingElement(p) && p.propertyName === id) ||
    ((ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isParameter(p)) &&
      p.name === id) ||
    ts.isImportSpecifier(p) ||
    ts.isExportSpecifier(p) ||
    ts.isImportClause(p)
  );
}

/** Each call of a named function: in its own scope, and, for one at a file's top, in the files importing it. */
function callersOf(files: ReadonlyMap<string, ts.SourceFile>, fn: Fn, name: string): ts.Node[] {
  const declaration = ts.isFunctionDeclaration(fn) ? fn : fn.parent;
  const declared = (declaration as ts.FunctionDeclaration | ts.VariableDeclaration).name;
  const scope = scopeOf(declaration);
  const here = namesIn(scope, name, declared);
  if (!ts.isSourceFile(scope)) return here;
  const file = scope.fileName;
  const elsewhere = [...files].flatMap(([other, source]) =>
    other === file ? [] : importedAs(source, file, name).flatMap((local) => namesIn(source, local)),
  );
  return [...here, ...elsewhere];
}

/** The names `source` imports `name` of `file` (a path relative to src) under. */
function importedAs(source: ts.SourceFile, file: string, name: string): string[] {
  return source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      return [];
    }
    const from = statement.moduleSpecifier.text;
    if (!from.startsWith('.')) return [];
    if (normalize(join(dirname(source.fileName), from)).replace(/\.js$/, '.ts') !== file) return [];
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) return [];
    return bindings.elements
      .filter((element) => (element.propertyName ?? element.name).text === name)
      .map((element) => element.name.text);
  });
}

/** packages/api/src's TypeScript, by path relative to it. */
function packageSources(): Map<string, string> {
  return new Map(
    (readdirSync(SRC, { recursive: true }) as string[])
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
      .map((file) => [file, readFileSync(join(SRC, file), 'utf8')]),
  );
}

describe('the sweep', () => {
  const fixture = new Map([
    [
      'routes/a.ts',
      `import { publishIt } from '../helper.js';
export function aRouter(binding, plan, r) {
  r.post('/', async (c) => {
    await admitPlan(c, plan, input, () => binding.publish(1));
    await binding.register(2);
    const promote = binding.promote;
    if (promote === undefined) return;
    await admitPlan(c, plan, input, () => promote(3));
    await admitPlan(c, plan, () => binding.reinstate(4), write);
    await publishIt(binding);
    const write = () => publishIt(binding);
    await admitPlan(c, plan, input, write);
  });
}`,
    ],
    ['helper.ts', 'export async function publishIt(b) { return b.publish(5); }'],
  ]);
  const writers = {
    'routes/a.ts: aRouter: binding.publish': 'x',
    'routes/a.ts: aRouter: binding.register': 'x',
    'routes/a.ts: aRouter: binding.promote': 'x',
    'routes/a.ts: aRouter: binding.reinstate': 'x',
    'helper.ts: publishIt: b.publish': 'x',
  };

  test('finds the writes, and each reached outside an admit', () => {
    const found = sweep(fixture, writers, {});
    expect(found.writes).toEqual([
      'helper.ts: publishIt: b.publish',
      'routes/a.ts: aRouter: binding.promote',
      'routes/a.ts: aRouter: binding.publish',
      'routes/a.ts: aRouter: binding.register',
      'routes/a.ts: aRouter: binding.reinstate',
    ]);
    // Inside the write an admit runs passes (by a function, or its name),
    // and so does a kept name's use there; anything else is reached outside.
    expect(found.unasked).toEqual([
      'helper.ts: publishIt: b.publish ← routes/a.ts: aRouter: publishIt ← nothing in src calls aRouter',
      'routes/a.ts: aRouter: binding.register ← nothing in src calls aRouter',
      'routes/a.ts: aRouter: binding.reinstate ← nothing in src calls aRouter',
    ]);
  });

  test('a place named uncounted passes, and is counted', () => {
    const found = sweep(fixture, writers, {
      'routes/a.ts: aRouter: binding.register': 'why',
      'routes/a.ts: aRouter: publishIt': 'why',
    });
    expect(found.unasked).toEqual([
      'routes/a.ts: aRouter: binding.reinstate ← nothing in src calls aRouter',
    ]);
    expect(found.uncounted).toEqual({
      'routes/a.ts: aRouter: binding.register': 1,
      'routes/a.ts: aRouter: publishIt': 1,
    });
  });
});

describe('packages/api/src', () => {
  const found = sweep(packageSources(), WRITERS, UNCOUNTED);

  test('each write is a writer of the plan limits, or another kind', () => {
    expect(found.writes).toEqual(Object.keys({ ...WRITERS, ...OTHER_KINDS }).sort());
  });

  test("each writer's write asks the plan limits", () => {
    expect(found.unasked).toEqual([]);
  });

  test('each place reached outside them is one site', () => {
    expect(found.uncounted).toEqual(
      Object.fromEntries(Object.keys(UNCOUNTED).map((place) => [place, 1])),
    );
  });

  test('all six writers are swept', () => {
    expect(new Set(Object.values(WRITERS))).toEqual(
      new Set(['publish', 'reinstate', 'deploy', 'promote', 'go live', 'a suggested change']),
    );
  });
});
