// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * A TypeDoc plugin for the TypeScript reference (`typeDoc.plugin` in
 * `astro.config.mjs`). With `useCodeBlocks`, typedoc-plugin-markdown writes
 * each declaration as a `ts` code block: a signature, not code to paste, so
 * its fence says `ts signature`. The code blocks the doc comments hold (an
 * `@example`, a block in a summary) stay as their authors wrote them.
 */
import { PageEvent, RendererEvent } from 'typedoc';

/** A fence's opening line: its indent, marker, language and the rest. */
const FENCE = /^(\s*)(`{3,}|~{3,})([^\s`]*)(.*)$/;

/** A code block's code: the lines between its fences, without its indent. */
function codeOf(lines, indent = '') {
  return lines
    .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
    .join('\n')
    .trimEnd();
}

/** The code of every code block in the project's doc comments. */
export function commentCode(project) {
  const code = new Set();
  const add = (parts = []) => {
    for (const part of parts) {
      const lines = part.kind === 'code' ? part.text.split('\n') : [];
      if (lines.length > 1 && FENCE.test(lines[0])) code.add(codeOf(lines.slice(1, -1)));
    }
  };
  for (const reflection of Object.values(project.reflections)) {
    if (!reflection.comment) continue;
    add(reflection.comment.summary);
    for (const tag of reflection.comment.blockTags) add(tag.content);
  }
  return code;
}

/**
 * `markdown` with each `ts` block that has no fence words yet, and whose
 * code isn't one of `fromComments`, fenced `ts signature`.
 */
export function markSignatures(markdown, fromComments) {
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(FENCE);
    if (!open) continue;
    const [, indent, marker, language, rest] = open;
    const close = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end])) end++;
    const code = codeOf(lines.slice(i + 1, end), indent);
    if (/^(ts|typescript)$/.test(language) && rest.trim() === '' && !fromComments.has(code)) {
      lines[i] = `${indent}${marker}${language} signature`;
    }
    i = end;
  }
  return lines.join('\n');
}

/** The plugin: TypeDoc calls it with the application, as it would a module's `load`. */
export function typedocSignatures(app) {
  let fromComments = new Set();
  app.renderer.on(RendererEvent.BEGIN, (event) => {
    fromComments = commentCode(event.project);
  });
  app.renderer.on(PageEvent.END, (page) => {
    if (page.contents) page.contents = markSignatures(page.contents, fromComments);
  });
}
