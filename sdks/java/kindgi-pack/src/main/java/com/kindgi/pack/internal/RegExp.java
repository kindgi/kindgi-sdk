// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Whether JavaScript would accept a regular expression, read without JavaScript.
 *
 * <p>{@link #problem} reads a source as V8 12.4 (the engine of Node 22) reads it in {@code new
 * RegExp(source, flags)}, and returns the reason V8 gives for refusing it: the text after {@code
 * Invalid regular expression: /<source>/<flags>: }. {@code null} when V8 accepts it. {@code unicode}
 * reads it with the {@code u} flag, otherwise with no flags; the other flags but {@code v} don't
 * change what V8 refuses.
 *
 * <p>It is V8's parser, step by step, with only the steps that can refuse kept, so the first
 * refusal V8 meets is the one returned. As in V8:
 *
 * <ul>
 *   <li>the pattern is read in UTF-16 code units, as JavaScript strings are (and Java's): a
 *       surrogate pair is joined into one character with {@code u} and in group names;
 *   <li>a back reference ({@code \2}) that needs the number of groups, or a {@code \k} that needs to
 *       know whether there are named groups, looks ahead through the rest of the pattern once;
 *   <li>named references ({@code \k<name>}) are checked against the group names at the end.
 * </ul>
 *
 * <p>The Unicode data it needs (the characters of group names, the names {@code \p{…}} takes) is
 * V8's, generated into {@link RegExpTables} by {@code scripts/regexp-tables.mjs}.
 *
 * <p>Not checked:
 *
 * <ul>
 *   <li>"Regular expression too large": V8 says it when it compiles a pattern for its first match,
 *       not when it reads one, so {@code new RegExp} doesn't.
 *   <li>"Stack overflow" and "Maximum call stack size exceeded": V8 reads a pattern without nesting
 *       calls, so these come only from a stack that is nearly full already.
 *   <li>the {@code v} flag, and what V8 12.4 has behind flags that are off in Node 22: modifiers
 *       ({@code (?i:…)}), which are refused here as V8 refuses them, and repeated group names in
 *       different alternatives, also refused.
 * </ul>
 */
final class RegExp {
  private RegExp() {}

  /**
   * The reason V8 refuses {@code source} as a regular expression, or {@code null} when it accepts
   * it; with the {@code u} flag when {@code unicode}, else with none.
   */
  static String problem(String source, boolean unicode) {
    try {
      new Parser(source, unicode).parse();
    } catch (Refused refused) {
      return refused.reason;
    }
    return null;
  }

  /** The current character past the end. */
  private static final int END = -1;

  private static final int MAX_CAPTURES = 32767;

  /** A quantifier's bound that is larger reads as this. */
  private static final int INFINITY = Integer.MAX_VALUE;

  private static final int[] ID_START = RegExpTables.ID_START;
  private static final int[] ID_CONTINUE = RegExpTables.ID_CONTINUE;
  private static final String SYNTAX = "^$\\.*+?()[]{}|/";

  private static final class Refused extends RuntimeException {
    private static final long serialVersionUID = 1L;
    final String reason;

    Refused(String reason) {
      super(reason, null, false, false);
      this.reason = reason;
    }
  }

  /** Whether the inclusive ranges, as first, last pairs in order, take {@code code}. */
  private static boolean among(int[] ranges, int code) {
    int low = 0;
    int high = ranges.length / 2 - 1;
    while (low <= high) {
      int mid = (low + high) >>> 1;
      if (ranges[2 * mid] > code) {
        high = mid - 1;
      } else if (ranges[2 * mid + 1] < code) {
        low = mid + 1;
      } else {
        return true;
      }
    }
    return false;
  }

  private static boolean digit(int c) {
    return c >= '0' && c <= '9';
  }

  private static int hexValue(int c) {
    if (c >= '0' && c <= '9') {
      return c - '0';
    }
    if (c >= 'a' && c <= 'f') {
      return c - 'a' + 10;
    }
    if (c >= 'A' && c <= 'F') {
      return c - 'A' + 10;
    }
    return -1;
  }

  private static boolean classEscape(int c) {
    return c == 'd' || c == 'D' || c == 's' || c == 'S' || c == 'w' || c == 'W';
  }

  private static boolean propertyCharacter(int c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || digit(c) || c == '_';
  }

  /** A class atom: its character, or {@code isClass} for a class within it ({@code \d}, {@code \p{…}}). */
  private record Atom(int code, boolean isClass) {}

  /** The kind of a group, and the name of a capture group that has one. */
  private record Group(String kind, String name) {}

  /**
   * V8's {@code RegExpParserImpl}: {@code cur} is the character being read ({@code END} past the
   * end) and {@code nextPos} the code unit after it, moved as V8 moves them.
   */
  private static final class Parser {
    private final String units;
    private final boolean unicode;
    /** In a group name, read as with {@code u}. */
    private boolean forceUnicode = false;

    private int cur = END;
    private int nextPos = 0;
    private boolean hasMore = true;
    private int capturesStarted = 0;
    /** All the groups, once looked ahead for. */
    private int captureCount = 0;

    private boolean scanned = false;
    private boolean hasNamed = false;
    private final Set<String> names = new HashSet<>();
    private final List<String> references = new ArrayList<>();

    Parser(String source, boolean unicode) {
      this.units = source;
      this.unicode = unicode;
      advance(1);
    }

    // Reading.

    private int read(boolean move) {
      int pos = nextPos;
      int c = units.charAt(pos);
      pos++;
      if ((unicode || forceUnicode) && pos < units.length() && c >= 0xD800 && c <= 0xDBFF) {
        int trail = units.charAt(pos);
        if (trail >= 0xDC00 && trail <= 0xDFFF) {
          c = 0x10000 + ((c - 0xD800) << 10) + trail - 0xDC00;
          pos++;
        }
      }
      if (move) {
        nextPos = pos;
      }
      return c;
    }

    private boolean at(int a) {
      return cur == a;
    }

    private boolean at(int a, int b) {
      return cur == a || cur == b;
    }

    private int peek() {
      return nextPos < units.length() ? read(false) : END;
    }

    private void advance(int dist) {
      nextPos += dist - 1;
      if (nextPos < units.length()) {
        cur = read(true);
      } else {
        cur = END;
        nextPos = units.length() + 1;
        hasMore = false;
      }
    }

    private int position() {
      return nextPos - 1;
    }

    private void reset(int pos) {
      nextPos = pos;
      hasMore = pos < units.length();
      advance(1);
    }

    private void rewind() {
      if (hasMore) {
        advance(cur > 0xFFFF ? -2 : -1);
      }
    }

    // The pattern.

    void parse() {
      List<Group> groups = new ArrayList<>(); // the open groups
      while (true) {
        int c = cur;
        String closed = null;
        if (c == END) {
          if (!groups.isEmpty()) {
            throw new Refused("Unterminated group");
          }
          break;
        }
        if (c == ')') {
          if (groups.isEmpty()) {
            throw new Refused("Unmatched ')'");
          }
          advance(1);
          Group group = groups.remove(groups.size() - 1);
          closed = group.kind();
          if (group.name() != null) {
            if (!names.add(group.name())) {
              throw new Refused("Duplicate capture group name");
            }
          }
        } else if (c == '|' || c == '^' || c == '$') {
          advance(1);
          continue;
        } else if (c == '*' || c == '+' || c == '?') {
          throw new Refused("Nothing to repeat");
        } else if (c == '(') {
          groups.add(openGroup());
          continue;
        } else if (c == '[') {
          characterClass();
        } else if (c == '\\') {
          if (!atomEscape()) {
            continue;
          }
        } else if (c == '{' || c == '}' || c == ']') {
          if (c == '{' && interval() != null) {
            throw new Refused("Nothing to repeat");
          }
          if (unicode) {
            throw new Refused("Lone quantifier brackets");
          }
          advance(1);
        } else {
          advance(1);
        }

        if (at('*', '+') || at('?')) {
          advance(1);
        } else if (at('{')) {
          int[] bounds = interval();
          if (bounds == null) {
            if (unicode) {
              throw new Refused("Incomplete quantifier");
            }
            continue;
          }
          if (bounds[1] < bounds[0]) {
            throw new Refused("numbers out of order in {} quantifier");
          }
        } else {
          continue;
        }
        if (at('?')) {
          advance(1);
        }
        if ("lookbehind".equals(closed) || ("lookahead".equals(closed) && unicode)) {
          throw new Refused("Invalid quantifier");
        }
      }
      // A reference inside the group it names isn't kept by V8; keeping it changes nothing
      // here, as that group's name is known once the group closes.
      for (String name : references) {
        if (!names.contains(name)) {
          throw new Refused("Invalid named capture referenced");
        }
      }
    }

    private Group openGroup() {
      advance(1);
      String kind = "capture";
      boolean named = false;
      if (at('?')) {
        int after = peek();
        if (after == ':' || after == '=' || after == '!') {
          advance(2);
          kind = after == ':' ? "group" : "lookahead";
        } else if (after == '<') {
          advance(1);
          if (peek() == '=' || peek() == '!') {
            advance(2);
            kind = "lookbehind";
          } else {
            named = true;
            hasNamed = true;
            advance(1);
          }
        } else { // modifiers, `(?i:…)`, are off in Node 22
          throw new Refused("Invalid group");
        }
      }
      String name = null;
      if (kind.equals("capture")) {
        if (capturesStarted >= MAX_CAPTURES) {
          throw new Refused("Too many captures");
        }
        capturesStarted++;
        if (named) {
          name = groupName();
        }
      }
      return new Group(kind, name);
    }

    /** Counts the groups from here on, and whether one is named, without reading them. */
    private void scanForCaptures(boolean inClass) {
      int saved = position();
      int count = capturesStarted;
      if (inClass) {
        while (cur != END) {
          int c = cur;
          advance(1);
          if (c == '\\') {
            advance(1);
          } else if (c == ']') {
            break;
          }
        }
      }
      while (cur != END) {
        int c = cur;
        advance(1);
        if (c == '\\') {
          advance(1);
        } else if (c == '[') {
          while (cur != END) {
            int d = cur;
            advance(1);
            if (d == '\\') {
              advance(1);
            } else if (d == ']') {
              break;
            }
          }
        } else if (c == '(') {
          if (at('?')) {
            advance(1);
            if (!at('<')) {
              continue;
            }
            advance(1);
            if (at('=', '!')) {
              continue;
            }
            hasNamed = true;
          }
          count++;
        }
      }
      captureCount = count;
      scanned = true;
      reset(saved);
    }

    private boolean hasNamedCaptures(boolean inClass) {
      if (!(hasNamed || scanned)) {
        scanForCaptures(inClass);
      }
      return hasNamed;
    }

    /** {@code {n}}, {@code {n,}} or {@code {n,m}} read, or {@code null} with nothing read. */
    private int[] interval() {
      int start = position();
      advance(1);
      if (!digit(cur)) {
        reset(start);
        return null;
      }
      int low = number();
      if (at('}')) {
        advance(1);
        return new int[] {low, low};
      }
      if (!at(',')) {
        reset(start);
        return null;
      }
      advance(1);
      if (at('}')) {
        advance(1);
        return new int[] {low, INFINITY};
      }
      int high = number();
      if (!at('}')) {
        reset(start);
        return null;
      }
      advance(1);
      return new int[] {low, high};
    }

    private int number() {
      long value = 0;
      while (digit(cur)) {
        value = Math.min(10 * value + cur - '0', INFINITY);
        advance(1);
      }
      return (int) value;
    }

    // Escapes.

    /** Reads an escape outside a class; {@code false} for {@code \b} and {@code \B}, which take no quantifier. */
    private boolean atomEscape() {
      int after = peek();
      if (after == END) {
        throw new Refused("\\ at end of pattern");
      }
      if (after >= '1' && after <= '9') {
        if (backReference()) {
          return true;
        }
        if (unicode) {
          throw new Refused("Invalid escape");
        }
        if (after == '8' || after == '9') {
          advance(2);
          return true;
        }
      }
      if (after >= '0' && after <= '7') {
        advance(1);
        if (unicode && digit(peek())) {
          throw new Refused("Invalid decimal escape");
        }
        octal();
      } else if (after == 'b' || after == 'B') {
        advance(2);
        return false;
      } else if (classEscape(after)) {
        advance(2);
      } else if (after == 'p' || after == 'P') {
        advance(2);
        if (unicode && !property()) {
          throw new Refused("Invalid property name");
        }
      } else if (after == 'k' && (hasNamedCaptures(false) || unicode)) {
        advance(2);
        if (!at('<')) {
          throw new Refused("Invalid named reference");
        }
        advance(1);
        references.add(groupName());
      } else {
        characterEscape(false);
      }
      return true;
    }

    /** Reads {@code \1}…, if there are that many groups; else reads nothing. */
    private boolean backReference() {
      int start = position();
      int value = peek() - '0';
      advance(2);
      while (digit(cur)) {
        value = 10 * value + cur - '0';
        if (value > MAX_CAPTURES) {
          reset(start);
          return false;
        }
        advance(1);
      }
      if (value > capturesStarted) {
        if (!scanned) {
          scanForCaptures(false);
        }
        if (value > captureCount) {
          reset(start);
          return false;
        }
      }
      return true;
    }

    private int characterEscape(boolean inClass) {
      advance(1);
      int c = cur;
      switch (c) {
        case 'f':
          advance(1);
          return 0x0C;
        case 'n':
          advance(1);
          return 0x0A;
        case 'r':
          advance(1);
          return 0x0D;
        case 't':
          advance(1);
          return 0x09;
        case 'v':
          advance(1);
          return 0x0B;
        default:
          break;
      }
      if (c == 'c') {
        int letter = peek();
        int code = letter != END ? letter : 0;
        if ((code & ~0x20) >= 0x41 && (code & ~0x20) <= 0x5A
            || (inClass && !unicode && (digit(code) || code == 0x5F))) {
          advance(2);
          return code & 0x1F;
        }
        if (unicode) {
          throw new Refused("Invalid Unicode escape");
        }
        return 0x5C; // the backslash alone; the `c` is read next
      }
      if (c == '0' && !digit(peek())) {
        advance(1);
        return 0;
      }
      if (c >= '0' && c <= '7') {
        if (unicode) {
          throw new Refused("Invalid class escape");
        }
        return octal();
      }
      if (c == 'x') {
        advance(1);
        int value = hex(2);
        if (value < 0 && unicode) {
          throw new Refused("Invalid escape");
        }
        return value < 0 ? 0x78 : value;
      }
      if (c == 'u') {
        advance(1);
        int value = unicodeEscape();
        if (value < 0 && unicode) {
          throw new Refused("Invalid Unicode escape");
        }
        return value < 0 ? 0x75 : value;
      }
      if (unicode && !(c != END && SYNTAX.indexOf(c) >= 0)) {
        throw new Refused("Invalid escape");
      }
      advance(1);
      if (!unicode && c == 'k' && hasNamedCaptures(inClass)) {
        throw new Refused("Invalid escape");
      }
      return c;
    }

    private int octal() {
      int value = cur - '0';
      advance(1);
      if (cur >= '0' && cur <= '7') {
        value = value * 8 + cur - '0';
        advance(1);
        if (value < 32 && cur >= '0' && cur <= '7') {
          value = value * 8 + cur - '0';
          advance(1);
        }
      }
      return value;
    }

    /** {@code length} hex digits read, as a number; {@code -1} with nothing read if they aren't. */
    private int hex(int length) {
      int start = position();
      int value = 0;
      for (int i = 0; i < length; i++) {
        int digit = hexValue(cur);
        if (digit < 0) {
          reset(start);
          return -1;
        }
        value = value * 16 + digit;
        advance(1);
      }
      return value;
    }

    /**
     * After a backslash and {@code u}: four hex digits, a surrogate pair of two such escapes and
     * {@code {X…}} with {@code u}; {@code -1} when it is none of them.
     */
    private int unicodeEscape() {
      boolean unicode = this.unicode || forceUnicode;
      if (at('{') && unicode) {
        int start = position();
        advance(1);
        int value = hexNumber();
        if (value >= 0 && at('}')) {
          advance(1);
          return value;
        }
        reset(start);
        return -1;
      }
      int value = hex(4);
      if (value >= 0 && unicode && value >= 0xD800 && value <= 0xDBFF && at('\\')) {
        int start = position();
        if (peek() == 'u') {
          advance(2);
          int trail = hex(4);
          if (trail >= 0xDC00 && trail <= 0xDFFF) {
            return 0x10000 + ((value - 0xD800) << 10) + trail - 0xDC00;
          }
        }
        reset(start);
      }
      return value;
    }

    /** Hex digits, read; {@code -1} with none, or with a value over 10FFFF. */
    private int hexNumber() {
      int digit = hexValue(cur);
      if (digit < 0) {
        return -1;
      }
      int value = 0;
      while (digit >= 0) {
        value = value * 16 + digit;
        if (value > 0x10FFFF) {
          return -1;
        }
        advance(1);
        digit = hexValue(cur);
      }
      return value;
    }

    /** A group's name, {@code <} read: its characters to the {@code >}, read as with {@code u}. */
    private String groupName() {
      rewind();
      StringBuilder name = new StringBuilder();
      forceUnicode = true;
      while (true) {
        advance(1);
        int code = cur;
        if (code == 0x5C && peek() == 'u') {
          advance(2);
          int value = unicodeEscape();
          if (value < 0) {
            throw new Refused("Invalid Unicode escape");
          }
          code = value;
          rewind();
        }
        if (code == 0x5C) {
          throw new Refused("Invalid capture group name");
        }
        if (name.length() == 0) {
          if (!among(ID_START, code)) {
            throw new Refused("Invalid capture group name");
          }
        } else if (code == 0x3E) {
          break;
        } else if (!among(ID_CONTINUE, code)) {
          throw new Refused("Invalid capture group name");
        }
        name.appendCodePoint(code);
      }
      forceUnicode = false;
      advance(1);
      return name.toString();
    }

    // Classes.

    private void characterClass() {
      advance(1);
      if (at('^')) {
        advance(1);
      }
      if (at(']')) {
        advance(1);
        return;
      }
      while (hasMore && !at(']')) {
        Atom first = classAtom();
        if (!at('-')) {
          continue;
        }
        advance(1);
        if (!hasMore || at(']')) {
          break;
        }
        Atom last = classAtom();
        if (first.isClass() || last.isClass()) {
          if (unicode) {
            throw new Refused("Invalid character class");
          }
        } else if (first.code() > last.code()) {
          throw new Refused("Range out of order in character class");
        }
      }
      if (!hasMore) {
        throw new Refused("Unterminated character class");
      }
      advance(1);
    }

    private Atom classAtom() {
      if (!at('\\')) {
        int code = cur;
        advance(1);
        return new Atom(code, false);
      }
      int after = peek();
      if (after == 'b' || (after == '-' && unicode)) {
        advance(2);
        return new Atom(after == 'b' ? 0x08 : 0x2D, false);
      }
      if (after == END) {
        throw new Refused("\\ at end of pattern");
      }
      if (classEscape(after)) {
        advance(2);
        return new Atom(0, true);
      }
      if ((after == 'p' || after == 'P') && unicode) {
        advance(2);
        if (!property()) {
          throw new Refused("Invalid property name in character class");
        }
        return new Atom(0, true);
      }
      return new Atom(characterEscape(true), false);
    }

    /** {@code {name}} or {@code {name=value}} after {@code \p}, read; whether V8 knows it. */
    private boolean property() {
      if (!at('{')) {
        return false;
      }
      advance(1);
      String name = propertyPart('=');
      if (name == null) {
        return false;
      }
      String value = null;
      if (at('=')) {
        advance(1);
        value = propertyPart('}');
        if (value == null) {
          return false;
        }
      }
      advance(1);
      if (value == null) {
        return RegExpTables.GENERAL_CATEGORIES.contains(name)
            || RegExpTables.BINARY_PROPERTIES.contains(name);
      }
      if (RegExpTables.GENERAL_CATEGORY_NAMES.contains(name)) {
        return RegExpTables.GENERAL_CATEGORIES.contains(value);
      }
      return RegExpTables.SCRIPT_NAMES.contains(name) && RegExpTables.SCRIPTS.contains(value);
    }

    private String propertyPart(int stop) {
      StringBuilder part = new StringBuilder();
      while (!at('}', stop)) {
        // V8 keeps a character's low 8 bits, so `Ł` (U+0141) reads as `A`.
        int low = cur != END ? cur & 0xFF : END;
        if (!propertyCharacter(low) || nextPos >= units.length()) {
          return null;
        }
        part.append((char) low);
        advance(1);
      }
      return part.toString();
    }
  }
}
