// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { hasHiddenCharacters, withoutHiddenCharacters } from '../src/index.js';

/** The black flag, then tag letters, then the cancel tag: a subdivision flag. */
function flag(letters: string): string {
  const tags = [...letters].map((letter) => String.fromCodePoint(0xe0000 + letter.charCodeAt(0)));
  return `\u{1F3F4}${tags.join('')}\u{E007F}`;
}

const ENGLAND = flag('gbeng');
const SCOTLAND = flag('gbsct');
const WALES = flag('gbwls');

// Half a surrogate pair: a JSON string can hold one, a source literal can't.
const LONE_HIGH = String.fromCharCode(0xd800);
const LONE_LOW = String.fromCharCode(0xdc00);

describe('hasHiddenCharacters', () => {
  test.each([
    ['NUL', '\u{0000}'],
    ['a tab', '\t'],
    ['a line feed', '\n'],
    ['a carriage return', '\r'],
    ['DEL', '\u{007F}'],
    ['a C1 control', '\u{0085}'],
    ['the line separator', '\u{2028}'],
    ['the paragraph separator', '\u{2029}'],
    ['a lone high surrogate', LONE_HIGH],
    ['a lone low surrogate', LONE_LOW],
    ['the right-to-left override', '\u{202E}'],
    ['a left-to-right isolate', '\u{2066}'],
    ['the right-to-left mark', '\u{200F}'],
    ['the Arabic letter mark', '\u{061C}'],
    ['the zero-width space', '\u{200B}'],
    ['the word joiner', '\u{2060}'],
    ['the byte-order mark', '\u{FEFF}'],
    ['the soft hyphen', '\u{00AD}'],
    ['the Mongolian vowel separator', '\u{180E}'],
    ['the Hangul filler', '\u{3164}'],
    ['the Hangul choseong filler', '\u{115F}'],
    ['the combining grapheme joiner', '\u{034F}'],
    ['an unassigned default ignorable', '\u{2065}'],
    ['a lone tag letter', '\u{E0041}'],
    ['the language tag', '\u{E0001}'],
    ['a flag-shaped run that is none of the three', flag('gbabc')],
    ['a kept flag cut short of its cancel tag', ENGLAND.slice(0, -2)],
    ['tag letters after a kept flag', `${WALES}\u{E0061}`],
  ])('finds %s', (_name, hidden) => {
    expect(hasHiddenCharacters(`Acme${hidden}Labs`)).toBe(true);
    expect(hasHiddenCharacters(hidden)).toBe(true);
  });

  test.each([
    ['plain text', 'Acme Labs'],
    [
      'a Persian name with the zero-width non-joiner',
      '\u{0645}\u{06CC}\u{200C}\u{0631}\u{0648}\u{0645}',
    ],
    ['an emoji sequence with the zero-width joiner', '\u{1F469}\u{200D}\u{1F4BB}'],
    ['a variation selector', '\u{2764}\u{FE0F}'],
    ['an ideographic variation selector', '\u{845B}\u{E0100}'],
    ['a combining mark', 'Cafe\u{0301}'],
    ['a no-break space', 'Acme\u{00A0}Labs'],
    ["England's flag", ENGLAND],
    ["Scotland's flag", SCOTLAND],
    ["Wales's flag", WALES],
    ['two kept flags in a row', `${SCOTLAND}${WALES}`],
  ])('keeps %s', (_name, text) => {
    expect(hasHiddenCharacters(text)).toBe(false);
  });
});

describe('withoutHiddenCharacters', () => {
  test('removes hidden characters, keeps the joiners and variation selectors, and trims', () => {
    expect(
      withoutHiddenCharacters(
        ' Ac\u{202E}me\u{200B}\u{3164} \u{1F469}\u{200D}\u{1F4BB}\u{2764}\u{FE0F}\n',
      ),
    ).toBe('Acme \u{1F469}\u{200D}\u{1F4BB}\u{2764}\u{FE0F}');
  });

  test('keeps the three flags whole, and removes every other tag character', () => {
    expect(withoutHiddenCharacters(`${ENGLAND} ${SCOTLAND} ${WALES}`)).toBe(
      `${ENGLAND} ${SCOTLAND} ${WALES}`,
    );
    expect(withoutHiddenCharacters(flag('gbabc'))).toBe('\u{1F3F4}');
    expect(withoutHiddenCharacters(ENGLAND.slice(0, -2))).toBe('\u{1F3F4}');
    expect(withoutHiddenCharacters(`${WALES}\u{E0061}`)).toBe(WALES);
  });

  test('removes a lone surrogate', () => {
    expect(withoutHiddenCharacters(`Ac${LONE_HIGH}me`)).toBe('Acme');
  });
});
