// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Poms read as text, with no XML library: enough to read coordinates and
 * dependencies, and to edit one element in place
 * (scripts/sync-jvm-version.mjs, scripts/check-jars.mjs). Comments, CDATA,
 * processing instructions and a DOCTYPE are skipped, so a `<version>` inside
 * a comment is never one. Attributes are read past, never kept: a pom's
 * elements carry what these scripts need.
 */

/** A pom that isn't well-formed XML. */
export class XmlError extends Error {}

const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)(?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*(\/?)>/g;

/**
 * @typedef {object} XmlElement
 * @property {string} name the element's name
 * @property {number} start where its content starts (after the start tag)
 * @property {number} end where its content ends (before the end tag)
 * @property {XmlElement[]} children its child elements, in order
 * @property {string} text its content, for an element without children
 * @property {boolean} empty written `<name/>`: no content at all
 */

/**
 * The document's root element, with its descendants.
 *
 * @param {string} text the document
 * @param {string} file its path, for the messages
 * @returns {XmlElement}
 */
export function xmlRoot(text, file) {
  const top = { name: '', start: 0, end: text.length, children: [], text: '', empty: false };
  const stack = [top];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (text.slice(last, match.index).includes('<')) {
      throw new XmlError(`${file}: not well-formed XML near offset ${last}`);
    }
    last = match.index + match[0].length;
    const [, closing, name, selfClosing] = match;
    if (name === undefined) continue;
    if (closing === '/') close(stack, name, text, match.index, file);
    else open(stack, name, last, selfClosing === '/');
  }
  if (text.slice(last).includes('<') || stack.length > 1) {
    throw new XmlError(
      `${file}: not well-formed XML (${stack.length > 1 ? `<${stack.at(-1).name}> is never closed` : 'trailing markup'})`,
    );
  }
  if (top.children.length !== 1) {
    throw new XmlError(`${file}: not one root element (${top.children.length})`);
  }
  return top.children[0];
}

/** A start tag: a child of the open element, itself open unless written `<name/>`. */
function open(stack, name, start, empty) {
  const element = { name, start, end: start, children: [], text: '', empty };
  stack[stack.length - 1].children.push(element);
  if (!empty) stack.push(element);
}

/** An end tag: it closes the open element, which must have its name. */
function close(stack, name, text, at, file) {
  const element = stack.length > 1 ? stack.pop() : undefined;
  if (element?.name !== name) {
    throw new XmlError(
      `${file}: </${name}> closes ${element === undefined ? 'nothing' : `<${element.name}>`}`,
    );
  }
  element.end = at;
  element.text = element.children.length > 0 ? '' : text.slice(element.start, at);
}

/**
 * The text-only elements of a pom, by path (`project/parent/version`), with
 * where their text is. `<a></a>` is one, with empty text; `<a/>` isn't.
 *
 * @param {string} text the pom
 * @param {string} file its path, for the messages
 * @returns {{ path: string, value: string, start: number, end: number }[]}
 */
export function pomLeaves(text, file) {
  const leaves = [];
  const walk = (element, prefix) => {
    const path = prefix === '' ? element.name : `${prefix}/${element.name}`;
    if (element.children.length > 0) {
      for (const child of element.children) walk(child, path);
    } else if (!element.empty) {
      leaves.push({ path, value: element.text, start: element.start, end: element.end });
    }
  };
  walk(xmlRoot(text, file), '');
  return leaves;
}

/** The children of `element` named `name`. */
export const childrenNamed = (element, name) =>
  (element?.children ?? []).filter((child) => child.name === name);

/** The trimmed text of `element`'s one child named `name`; undefined when there's none. */
export function childText(element, name) {
  const found = childrenNamed(element, name);
  return found.length === 0 ? undefined : found[0].text.trim();
}
