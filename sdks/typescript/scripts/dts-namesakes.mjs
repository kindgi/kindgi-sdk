// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
//
// dts-bundle-generator exports every type it inlines (its
// `exportReferencedTypes`). An inlined type that shares a name with one
// of src/index.ts's own exports is then exported twice: as itself, and as
// the entry's renamed `X$1 as X`. A consumer gets TS2484 (with
// `skipLibCheck: false`) or, with it on, whichever of the two TypeScript
// picks. The name means what src/index.ts exports: the inlined namesake
// stays declared, unexported.

const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const DECLARATION =
  '(?:declare )?(?:abstract class|interface|type|const|class|function|enum|namespace)';

/** The names an `export { … }` list gives to a renamed declaration (`X$1 as X`). */
function renamedExports(text) {
  const names = new Set();
  for (const list of text.matchAll(/^export (?:type )?\{([^}]*)\}/gm)) {
    for (const alias of list[1].matchAll(new RegExp(`${NAME}\\$\\d+ as (${NAME})`, 'g'))) {
      names.add(alias[1]);
    }
  }
  return names;
}

/** A top-level `export <declaration> name`: the inlined namesake. */
const exportedDeclaration = (name) => new RegExp(`^export (${DECLARATION} ${name})\\b`, 'gm');

/** `text` with each name exported once: an inlined namesake loses its `export`. */
export function unexportNamesakes(text) {
  let out = text;
  for (const name of renamedExports(text)) out = out.replace(exportedDeclaration(name), '$1');
  return out;
}

/** The names still exported twice in `text` (none, once `unexportNamesakes` ran). */
export function namesExportedTwice(text) {
  return [...renamedExports(text)].filter((name) => exportedDeclaration(name).test(text));
}
