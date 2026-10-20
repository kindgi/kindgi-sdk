// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { nestedSupers, trackedSources } from './check-constructor-super.mjs';

const REFUSAL = `
class Refused extends Error {
  readonly code: string;
  constructor(
    readonly primitive: string,
    private readonly id: string,
    outcome: { readonly reason?: string },
  ) {
    if (outcome.reason !== undefined) {
      super(outcome.reason);
      this.code = 'decided';
      return;
    }
    super('refused');
    this.code = 'refused';
  }
}
`;

/** `text`'s class `Refused`, as tsc emits it for ES2023 (the repository's target), run. */
function emitted(text) {
  const { outputText } = ts.transpileModule(`${text}\nmodule.exports = Refused;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
  });
  const module = { exports: {} };
  new Function('module', outputText)(module);
  return module.exports;
}

test("tsc's emit: a parameter property is unset after a `super` inside a block, set after the root one", () => {
  const Refused = emitted(REFUSAL);
  assert.equal(new Refused('guardrail', 'acme.check', { reason: 'decided' }).primitive, undefined);
  assert.equal(new Refused('guardrail', 'acme.check', {}).primitive, 'guardrail');
});

test('a `super` inside a block, with parameter properties: named, with its line and the properties', () => {
  assert.deepEqual(nestedSupers('refused.ts', REFUSAL), [
    { line: 10, className: 'Refused', properties: ['primitive', 'id'] },
  ]);
});

test('one `super` at the root, or none of the parameters a property: nothing', () => {
  const atRoot = `
class Refused extends Error {
  constructor(readonly primitive: string) {
    const message = primitive === 'tool' ? 'a tool' : 'another';
    super(message);
  }
}`;
  const byHand = `
class Refused extends Error {
  readonly primitive: string;
  constructor(primitive: string, decided: boolean) {
    if (decided) {
      super('decided');
    } else {
      super('refused');
    }
    this.primitive = primitive;
  }
}`;
  assert.deepEqual(nestedSupers('at-root.ts', atRoot), []);
  assert.deepEqual(nestedSupers('by-hand.ts', byHand), []);
});

test("a nested class's constructor is checked as its own, and a `super` in an arrow function counts", () => {
  const text = `
class Outer extends Error {
  constructor(readonly id: string) {
    super(id);
    class Inner extends Error {
      constructor(message: string) {
        if (message) super(message);
        else super('none');
      }
    }
  }
}
class Deferred extends Error {
  constructor(readonly id: string) {
    const later = () => super(id);
    later();
  }
}`;
  assert.deepEqual(nestedSupers('nested.ts', text), [
    { line: 15, className: 'Deferred', properties: ['id'] },
  ]);
});

test('the sources it reads: tracked TypeScript, no declaration files', () => {
  const files = trackedSources();
  assert.ok(files.includes('packages/api/src/publish-refused.ts'));
  assert.ok(files.every((file) => /\.[mc]?tsx?$/.test(file) && !/\.d\.[mc]?ts$/.test(file)));
});

test('run through a symlink, it still checks (and says how many files)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-constructor-super-'));
  try {
    const linked = join(dir, 'check-constructor-super.mjs');
    symlinkSync(fileURLToPath(new URL('./check-constructor-super.mjs', import.meta.url)), linked);
    const printed = execFileSync(process.execPath, [linked], { encoding: 'utf8' });
    assert.match(printed, /^check:constructor-super: \d+ files: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
