// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Hidden characters: what can disguise a name people set, or hide text in
 * it. A name or a label is refused when it has one
 * ({@link hasHiddenCharacters}). A person's name that a site sends is cleaned
 * of them instead ({@link withoutHiddenCharacters}), since refusing it would
 * keep that person out.
 *
 * Hidden, by Unicode class:
 * - every control character (Cc), a line break and a tab among them, since a
 *   name is one line; the line and paragraph separators (U+2028, U+2029); and
 *   a lone surrogate (Cs), which a JSON string can hold but isn't text;
 * - every format character (Cf) but the joiners: the bidirectional marks,
 *   embeddings, overrides and isolates, the zero-width space, the word
 *   joiner, the byte-order mark, the soft hyphen and the tag characters;
 * - every other default ignorable code point but the variation selectors:
 *   the combining grapheme joiner (U+034F) and the Hangul fillers, such as
 *   U+3164, among them.
 *
 * Kept: the zero-width non-joiner and joiner (U+200C, U+200D), which names in
 * Persian and Indic scripts, and emoji sequences, need; the variation
 * selectors, which emoji need; and the subdivision flags of England, Scotland
 * and Wales, whose tag characters are kept in those three sequences alone.
 * Any other tag character is hidden: a flag-shaped run that isn't one of the
 * three draws as the black flag alone, and its tags can spell text.
 *
 * The classes follow the Unicode data of the Node that runs the check, so a
 * later Unicode can add to them.
 */

/** A hidden character: see the module's comment. */
const HIDDEN =
  '(?![\\u200c\\u200d])(?:[\\p{Cc}\\p{Cs}\\p{Cf}\\u2028\\u2029]|(?!\\p{Variation_Selector})\\p{Default_Ignorable_Code_Point})';

/** The three subdivision flags whose tag characters are kept. */
const KEPT_FLAG =
  '\\u{1F3F4}\\u{E0067}\\u{E0062}(?:\\u{E0065}\\u{E006E}\\u{E0067}|\\u{E0073}\\u{E0063}\\u{E0074}|\\u{E0077}\\u{E006C}\\u{E0073})\\u{E007F}';

/** A kept flag, captured, or a hidden character. */
const SCAN = new RegExp(`(${KEPT_FLAG})|${HIDDEN}`, 'gu');

/** Whether `text` holds a hidden character. */
export function hasHiddenCharacters(text: string): boolean {
  for (const [, flag] of text.matchAll(SCAN)) {
    if (flag === undefined) return true;
  }
  return false;
}

/** `text` with every hidden character removed, then trimmed. */
export function withoutHiddenCharacters(text: string): string {
  return text.replace(SCAN, (_hidden: string, flag: string | undefined) => flag ?? '').trim();
}
