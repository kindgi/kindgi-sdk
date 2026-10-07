// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
//
// dts-bundle-generator declares an inlined name with everything it has.
// A generated schema is a type and a zod value under one name
// (`type LivePin` beside `const LivePin = z.object(…)`), and src/index.ts
// exports the type alone; the bundle exported the value too, so
// `LivePin.parse()` type-checked and failed at runtime. A value the
// runtime module doesn't export stays declared (a type may read it with
// `typeof`), unexported.

const NAME = '[A-Za-z_$][A-Za-z0-9_$]*';
const VALUE = '(?:const|let|var|function|abstract class|class|enum)';
const valueDeclaration = () => new RegExp(`^export (declare ${VALUE} (${NAME}))`, 'gm');

/** The names `text` exports as values (each `export declare <value> name`), once each. */
export function valueExports(text) {
  return [...new Set([...text.matchAll(valueDeclaration())].map((m) => m[2]))];
}

/** `text` with each value export that `runtimeNames` lacks unexported. */
export function unexportPhantomValues(text, runtimeNames) {
  const real = new Set(runtimeNames);
  return text.replace(valueDeclaration(), (line, declaration, name) =>
    real.has(name) ? line : declaration,
  );
}
