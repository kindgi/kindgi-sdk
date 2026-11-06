// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
// reads-source: sdks/typescript/src/**

/**
 * Every resource client's type is exported.
 *
 * A `...Client` interface or type that a module under `src/` declares is the
 * shape of something `createClient()` answers: `client.projects`,
 * `client.projects.memberships`, and so on. The package's entry exports each
 * one, so a caller can name it and the API reference gives it a page.
 */

import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

const program = ts.createProgram(ts.sys.readDirectory(SRC, ['.ts']), {
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  types: [],
});
const checker = program.getTypeChecker();

function exportsOf(file: ts.SourceFile): ts.Symbol[] {
  const moduleSymbol = checker.getSymbolAtLocation(file);
  return moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol);
}

const isClientType = (symbol: ts.Symbol): boolean =>
  symbol.name.endsWith('Client') &&
  (symbol.declarations ?? []).some(
    (d) => ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d),
  );

/** A `@deprecated` client type is an old path's, kept until it goes: the entry exports its replacement. */
const isDeprecated = (symbol: ts.Symbol): boolean =>
  (symbol.declarations ?? []).some((d) => ts.getJSDocDeprecatedTag(d) !== undefined);

/** Each client type a module under `src/` declares (not re-exports), with its module. */
const declared: { symbol: ts.Symbol; module: string }[] = [];
for (const file of program.getSourceFiles()) {
  if (
    file.isDeclarationFile ||
    !file.fileName.startsWith(SRC) ||
    file.fileName.endsWith('.test.ts')
  )
    continue;
  for (const symbol of exportsOf(file)) {
    const isAlias = (symbol.flags & ts.SymbolFlags.Alias) !== 0;
    if (!isAlias && isClientType(symbol) && !isDeprecated(symbol)) {
      declared.push({ symbol, module: file.fileName.slice(SRC.length) });
    }
  }
}

const index = program.getSourceFile(`${SRC}index.ts`);
if (index === undefined) throw new Error(`${SRC}index.ts isn't in the program`);
const exported = new Map(exportsOf(index).map((s) => [s.name, s] as const));
const target = (symbol: ts.Symbol): ts.Symbol =>
  symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

describe('the client types the package exports', () => {
  it('finds the client types its modules declare', () => {
    // A guard that finds nothing passes whatever the entry exports.
    const names = declared.map(({ symbol }) => symbol.name);
    expect(names).toContain('KindgiClient');
    expect(names).toContain('ProjectMembershipsClient');
    expect(names.length).toBeGreaterThan(90);
  });

  it('exports every client type a module declares, from the entry', () => {
    // By declaration, not name: a namesake the entry exports instead is missing too.
    const missing = declared
      .filter(({ symbol }) => {
        const entry = exported.get(symbol.name);
        return entry === undefined || target(entry) !== symbol;
      })
      .map(({ symbol, module }) => `${symbol.name} (${module})`)
      .sort();
    expect(missing, "add each to its module's `export type { ... }` block in src/index.ts").toEqual(
      [],
    );
  });
});
