// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
// reads-source: packages/sdk/src/client.ts sdks/typescript/src/**

/**
 * `@kindgi/sdk/client` re-exports every resource client's type.
 *
 * Each `...Client` interface or type that `@kindgi/client` exports is the
 * shape of something `createClient()` answers. The sub-path re-exports each
 * one, as the same declaration, so `import type { ProjectsClient } from
 * '@kindgi/sdk/client'` works and the API reference gives it a page. Read
 * from both packages' sources, so no build is needed.
 */

import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SDK_CLIENT = fileURLToPath(new URL('../src/client.ts', import.meta.url));
const CLIENT_INDEX = fileURLToPath(
  new URL('../../../sdks/typescript/src/index.ts', import.meta.url),
);

const program = ts.createProgram([SDK_CLIENT], {
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  paths: { '@kindgi/client': [CLIENT_INDEX] },
  types: [],
});
const checker = program.getTypeChecker();

function exportsOf(path: string): ts.Symbol[] {
  const file = program.getSourceFile(path);
  if (file === undefined) throw new Error(`${path} isn't in the program`);
  const moduleSymbol = checker.getSymbolAtLocation(file);
  return moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol);
}

const target = (symbol: ts.Symbol): ts.Symbol =>
  symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

const isClientType = (symbol: ts.Symbol): boolean =>
  symbol.name.endsWith('Client') &&
  (symbol.declarations ?? []).some(
    (d) => ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d),
  );

const clientTypes = exportsOf(CLIENT_INDEX)
  .map((s) => ({ name: s.name, declaration: target(s) }))
  .filter(({ declaration }) => isClientType(declaration));
const sdkExports = new Map(exportsOf(SDK_CLIENT).map((s) => [s.name, target(s)] as const));

describe("@kindgi/sdk/client and @kindgi/client's client types", () => {
  it("finds @kindgi/client's client types", () => {
    // A guard that finds nothing passes whatever the sub-path exports.
    const names = clientTypes.map(({ name }) => name);
    expect(names).toContain('KindgiClient');
    expect(names).toContain('ProjectsClient');
    expect(names.length).toBeGreaterThan(90);
  });

  it('re-exports every one, as the same declaration', () => {
    const missing = clientTypes
      .filter(({ name, declaration }) => sdkExports.get(name) !== declaration)
      .map(({ name }) => name)
      .sort();
    expect(missing, "add each to src/client.ts's resource client list").toEqual([]);
  });
});
