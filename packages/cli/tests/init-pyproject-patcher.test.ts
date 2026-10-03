// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { parse } from 'smol-toml';
import { describe, expect, test } from 'vitest';

import {
  addProjectDependency,
  addTableKey,
  addUvSource,
  appendTables,
  normalizeName,
  readPyproject,
  requirementName,
} from '../src/init/pyproject-patcher.js';

function ok(edit: { kind: 'ok'; text: string } | { kind: 'err'; message: string }): string {
  if (edit.kind === 'err') throw new Error(edit.message);
  return edit.text;
}

function deps(text: string): unknown {
  return (parse(text) as { project: { dependencies?: unknown } }).project.dependencies;
}

describe('readPyproject', () => {
  test('a PEP 621 project', () => {
    const r = readPyproject(
      '[project]\nname = "Acme_Widgets"\nversion = "2.3.0"\ndependencies = ["Kindgi[x]>=0.1", "httpx"]\n',
    );
    expect(r).toEqual({
      kind: 'ok',
      info: {
        name: 'Acme_Widgets',
        version: '2.3.0',
        isPack: false,
        dependencyStyle: 'pep621',
        hasKindgiDependency: true,
        usesPoetry: false,
        usesUv: false,
        uvRequiredVersion: undefined,
      },
    });
  });

  test('a pack, dynamic dependencies, Poetry 1, nothing parseable', () => {
    const pack = readPyproject('[project]\nname = "x"\n\n[tool.kindgi.pack]\nid = "x"\n');
    expect(pack.kind === 'ok' && pack.info.isPack).toBe(true);
    const dynamic = readPyproject('[project]\nname = "x"\ndynamic = ["dependencies", "version"]\n');
    expect(dynamic.kind === 'ok' && dynamic.info.dependencyStyle).toBe('dynamic');
    const poetry = readPyproject('[tool.poetry]\nname = "x"\n');
    expect(poetry.kind === 'ok' && poetry.info).toMatchObject({
      name: 'x',
      dependencyStyle: 'none',
      usesPoetry: true,
    });
    expect(readPyproject('[project\n').kind).toBe('err');
  });

  test('names normalize per PEP 503', () => {
    expect(normalizeName('Acme__Widgets.Core')).toBe('acme-widgets-core');
    expect(requirementName('kindgi ; python_version >= "3.11"')).toBe('kindgi');
    expect(requirementName('kindgi-tools>=1')).toBe('kindgi-tools');
  });
});

describe('addProjectDependency', () => {
  test('a multi-line array keeps its layout and gains a line', () => {
    const before =
      '[project]\nname = "app"\ndependencies = [\n    "httpx>=0.27",  # the client\n    "pydantic",\n]\n\n[tool.ruff]\nline-length = 100\n';
    const after = ok(addProjectDependency(before, 'kindgi'));
    expect(after).toBe(
      '[project]\nname = "app"\ndependencies = [\n    "httpx>=0.27",  # the client\n    "pydantic",\n    "kindgi",\n]\n\n[tool.ruff]\nline-length = 100\n',
    );
  });

  test('without a trailing comma; inline; empty; absent', () => {
    expect(
      deps(ok(addProjectDependency('[project]\ndependencies = [\n  "a"\n]\n', 'kindgi'))),
    ).toEqual(['a', 'kindgi']);
    expect(ok(addProjectDependency('[project]\ndependencies = ["a", "b"]\n', 'kindgi'))).toBe(
      '[project]\ndependencies = ["a", "b", "kindgi"]\n',
    );
    expect(ok(addProjectDependency('[project]\ndependencies = []\n', 'kindgi'))).toBe(
      '[project]\ndependencies = ["kindgi"]\n',
    );
    expect(ok(addProjectDependency('[project]\nname = "app"\n', 'kindgi'))).toBe(
      '[project]\ndependencies = ["kindgi"]\nname = "app"\n',
    );
  });

  test('brackets and quotes inside strings and comments do not confuse it', () => {
    const before =
      '[project]\nname = "app"\ndescription = "uses [brackets] and \\"quotes\\""\ndependencies = [\n    "pkg[extra]>=1",  # a comment with ] and [\n    \'single\',\n]\n[[tool.mypy.overrides]]\nmodule = "x"\n';
    const after = ok(addProjectDependency(before, 'kindgi'));
    expect(deps(after)).toEqual(['pkg[extra]>=1', 'single', 'kindgi']);
  });

  test('only [project] is edited: a later table with its own dependencies is untouched', () => {
    const before = '[project]\nname = "app"\n\n[tool.other]\ndependencies = ["not-this"]\n';
    const after = ok(addProjectDependency(before, 'kindgi'));
    const doc = parse(after) as {
      project: { dependencies: string[] };
      tool: { other: { dependencies: string[] } };
    };
    expect(doc.project.dependencies).toEqual(['kindgi']);
    expect(doc.tool.other.dependencies).toEqual(['not-this']);
  });

  test('no [project] table, or dependencies that are not an array: refused', () => {
    expect(addProjectDependency('[tool.poetry]\nname = "x"\n', 'kindgi').kind).toBe('err');
    expect(addProjectDependency('[project]\ndependencies = "nope"\n', 'kindgi').kind).toBe('err');
  });
});

describe('addUvSource', () => {
  const source = '{ path = "/src/kindgi/sdks/python", editable = true }';

  test('appends the table when absent', () => {
    const after = ok(addUvSource('[project]\nname = "app"\n', 'kindgi', source));
    expect(parse(after)).toMatchObject({
      tool: { uv: { sources: { kindgi: { path: '/src/kindgi/sdks/python', editable: true } } } },
    });
  });

  test('adds a key under an existing [tool.uv.sources]', () => {
    const before = '[project]\nname = "app"\n\n[tool.uv.sources]\nmylib = { path = "../mylib" }\n';
    const after = ok(addUvSource(before, 'kindgi', source));
    expect(parse(after)).toMatchObject({
      tool: { uv: { sources: { mylib: { path: '../mylib' }, kindgi: { editable: true } } } },
    });
  });

  test('sources declared inline under [tool.uv] can not take a table: refused', () => {
    const before = '[tool.uv]\nsources = { mylib = { path = "../mylib" } }\n';
    expect(addUvSource(before, 'kindgi', source).kind).toBe('err');
  });
});

describe('addTableKey', () => {
  test('under an existing header, in a new table, and never over a set key', () => {
    expect(
      ok(addTableKey('[tool.uv]\npackage = true\n', 'tool.uv', 'required-version', '">=0.12"')),
    ).toBe('[tool.uv]\nrequired-version = ">=0.12"\npackage = true\n');
    expect(
      parse(ok(addTableKey('[project]\nname = "a"\n', 'tool.uv', 'required-version', '">=0.12"'))),
    ).toMatchObject({ tool: { uv: { 'required-version': '>=0.12' } } });
    expect(
      addTableKey(
        '[tool.uv]\nrequired-version = "==0.11.0"\n',
        'tool.uv',
        'required-version',
        '">=0.12"',
      ).kind,
    ).toBe('err');
  });
});

describe('appendTables', () => {
  test('appends whole tables, verified against what they should add', () => {
    const after = ok(
      appendTables('[project]\nname = "app"', '[tool.kindgi.pack]\nid = "app"\n', {
        tool: { kindgi: { pack: { id: 'app' } } },
      }),
    );
    expect(after).toBe('[project]\nname = "app"\n\n[tool.kindgi.pack]\nid = "app"\n');
    expect(
      appendTables('[project]\nname = "app"\n', '[tool.kindgi.pack]\nid = "app"\n', {
        tool: { kindgi: { pack: { id: 'other' } } },
      }).kind,
    ).toBe('err');
  });
});
