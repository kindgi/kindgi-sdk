// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * Excerpts and signatures: code blocks that aren't offered for copying. A
 * reader (or a coding agent) who copies a block expects it to run as
 * pasted; a block that leaves something out can't, and a signature (a
 * reference page's declaration of a function or class) isn't code to run.
 *
 * A block is an excerpt when its fence says so (```` ```ts excerpt ````) or
 * when it contains the elision mark `…`, which is how the docs mark
 * something left out. A whole TypeScript, Python, Java or Scala file (its
 * first line names it) is the exception: it's compiled, so a `…` in it is
 * its own text ('One more thing…'). Every other code block is offered for
 * copying, and `check-samples.mjs` checks it: a whole file compiles, a shell
 * command names commands and flags the CLI has, JSON parses.
 *
 * A signature's fence says so (```` ```python signature ````): the reference
 * generators write it.
 *
 * On the page, an excerpt's frame carries the class `is-excerpt`, has no
 * copy button, and ends with a `div.excerpt` label; a signature's, the same
 * with `is-signature` and `div.signature`. So whatever reads the built page
 * can tell them from a block offered for copying.
 */

/** The fence word that marks an excerpt. */
export const EXCERPT = 'excerpt';
/** The fence word that marks a signature. */
export const SIGNATURE = 'signature';
/** The elision mark: a block that contains it leaves something out. */
export const ELISION = '…';

/**
 * The blocks not offered for copying, by fence word: the class their frame
 * carries, and the label at its foot (in a `div` whose class is the word).
 */
export const UNCOPIED = {
  [EXCERPT]: { className: 'is-excerpt', label: 'Excerpt' },
  [SIGNATURE]: { className: 'is-signature', label: 'Signature' },
};

/** The fence languages whose whole files `check-samples.mjs` compiles. */
export const COMPILED = new Set(['ts', 'typescript', 'tsx', 'python', 'py', 'java', 'scala']);

/**
 * Whether a block is an excerpt: its fence's meta has the bare word
 * `excerpt`, or its code contains `…` and it isn't a whole file in a
 * compiled language (`named`: its first line names the file).
 */
export function isExcerpt({ language, meta, code, named }) {
  if (metaWords(meta).includes(EXCERPT)) return true;
  if (named && COMPILED.has(language)) return false;
  return code.includes(ELISION);
}

/**
 * What a block is when it isn't offered for copying: `'signature'` when its
 * fence says so, `'excerpt'` when it's an excerpt (`isExcerpt`); otherwise
 * undefined.
 */
export function uncopied(block) {
  if (metaWords(block.meta).includes(SIGNATURE)) return SIGNATURE;
  return isExcerpt(block) ? EXCERPT : undefined;
}

/** The bare words of a fence's meta (`excerpt`, not `title="…"` or `{1,3}`). */
export function metaWords(meta) {
  const words = [];
  // Quoted values, ranges and regular expressions are values, not words.
  const plain = meta.replace(/"[^"]*"|'[^']*'|\{[^}]*\}|\/(?:\\.|[^/\\])*\//g, ' ');
  for (const token of plain.split(/\s+/)) {
    if (/^[\w-]+$/.test(token)) words.push(token);
  }
  return words;
}

function hasClass(node, name) {
  const className = node.properties?.className;
  return Array.isArray(className) ? className.includes(name) : className === name;
}

/**
 * The Expressive Code plugin. It runs after the frames plugin has wrapped
 * the block in its `figure.frame` and added the copy button, so it takes
 * the button out of an excerpt's or a signature's frame and adds the label.
 */
export function excerpts() {
  return {
    name: 'kindgi-excerpts',
    baseStyles: `
      .frame.is-excerpt .excerpt,
      .frame.is-signature .signature {
        border-top: 1px solid var(--kg-rule);
        background: var(--kg-code-bg);
        color: var(--kg-code-text);
        font-family: var(--kg-font);
        font-size: 0.75rem;
        line-height: 1.5;
        padding: 0.25rem 1rem;
      }
    `,
    hooks: {
      postprocessRenderedBlock: ({ codeBlock, renderData }) => {
        // The frames plugin has moved a first line that names the file into
        // the title; a title from the fence (`title="…"`) doesn't name a whole file.
        const named = Boolean(codeBlock.props.title) && !/(?:^|\s)title=/.test(codeBlock.meta);
        const block = {
          language: codeBlock.language,
          meta: codeBlock.meta,
          code: codeBlock.code,
          named,
        };
        const kind = uncopied(block);
        if (kind === undefined) return;
        const figure = renderData.blockAst;
        if (figure.tagName !== 'figure' || !hasClass(figure, 'frame')) {
          throw new Error(
            'kindgi-excerpts: the block is not in a frame yet; the plugin must run after the frames plugin.',
          );
        }
        const className = [figure.properties.className ?? []].flat();
        figure.properties.className = [...className, UNCOPIED[kind].className];
        figure.children = [
          ...figure.children.filter(
            (child) => !(child.type === 'element' && hasClass(child, 'copy')),
          ),
          {
            type: 'element',
            tagName: 'div',
            properties: { className: [kind] },
            children: [{ type: 'text', value: UNCOPIED[kind].label }],
          },
        ];
      },
    },
  };
}
