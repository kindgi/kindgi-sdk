# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""Whether JavaScript would accept a regular expression, read without JavaScript.

`regexp_problem(source, unicode=...)` reads `source` as V8 12.4 (the engine of Node 22) reads
it in `new RegExp(source, flags)`, and returns the reason V8 gives for refusing it: the text
after `Invalid regular expression: /<source>/<flags>: `. `None` when V8 accepts it.
`unicode=True` reads it with the `u` flag, `False` with no flags; the other flags but `v` don't
change what V8 refuses.

It is V8's parser, step by step, with only the steps that can refuse kept, so the first refusal
V8 meets is the one returned. As in V8:

- the pattern is read in UTF-16 code units, as JavaScript strings are: an astral character is
  two, joined into one with `u` and in group names;
- a back reference (`\\2`) that needs the number of groups, or a `\\k` that needs to know
  whether there are named groups, looks ahead through the rest of the pattern once;
- named references (`\\k<name>`) are checked against the group names at the end.

The Unicode data it needs (the characters of group names, the names `\\p{…}` takes) is V8's,
generated into `_regexp_tables` by `scripts/regexp-tables.mjs`.

Not checked:

- "Regular expression too large": V8 says it when it compiles a pattern for its first match, not
  when it reads one, so `new RegExp` doesn't.
- "Stack overflow" and "Maximum call stack size exceeded": V8 reads a pattern without nesting
  calls, so these come only from a stack that is nearly full already.
- the `v` flag, and what V8 12.4 has behind flags that are off in Node 22: modifiers
  (`(?i:…)`), which are refused here as V8 refuses them, and repeated group names in different
  alternatives, also refused.
"""

from __future__ import annotations

from bisect import bisect_right

from ._regexp_tables import (
    BINARY_PROPERTIES,
    GENERAL_CATEGORIES,
    GENERAL_CATEGORY_NAMES,
    ID_CONTINUE,
    ID_START,
    SCRIPT_NAMES,
    SCRIPTS,
)

__all__ = ["regexp_problem"]


def regexp_problem(source: str, *, unicode: bool) -> str | None:
    """The reason V8 refuses `source` as a regular expression, or `None` when it accepts it;
    with the `u` flag when `unicode`, else with none."""
    try:
        _Parser(source, unicode).parse()
    except _Refused as refused:
        return refused.reason
    return None


_END = ""  # the current character past the end
_MAX_CAPTURES = 32767
_INFINITY = 2**31 - 1  # a quantifier's bound that is larger reads as this

_CONTROL = {"f": 0x0C, "n": 0x0A, "r": 0x0D, "t": 0x09, "v": 0x0B}
_SYNTAX = frozenset("^$\\.*+?()[]{}|/")
_CLASS_ESCAPES = frozenset("dDsSwW")
_HEX = {c: int(c, 16) for c in "0123456789abcdefABCDEF"}
_PROPERTY_CHARACTERS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_")


class _Refused(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _among(ranges: tuple[tuple[int, int], ...], code: int) -> bool:
    i = bisect_right(ranges, code, key=lambda r: r[0])
    return i > 0 and ranges[i - 1][1] >= code


class _Parser:
    """V8's `RegExpParserImpl`: `cur` is the character being read (`_END` past the end) and
    `next_pos` the code unit after it, moved as V8 moves them."""

    def __init__(self, source: str, unicode: bool) -> None:
        self.units: list[str] = []
        for ch in source:
            code = ord(ch)
            if code > 0xFFFF:
                code -= 0x10000
                self.units += (chr(0xD800 + (code >> 10)), chr(0xDC00 + (code & 0x3FF)))
            else:
                self.units.append(ch)
        self.unicode = unicode
        self.force_unicode = False  # in a group name, read as with `u`
        self.cur = _END
        self.next_pos = 0
        self.has_more = True
        self.captures_started = 0
        self.capture_count = 0  # all the groups, once looked ahead for
        self.scanned = False
        self.has_named = False
        self.names: set[str] = set()
        self.references: list[str] = []
        self.advance()

    # Reading.

    def read(self, move: bool) -> str:
        pos = self.next_pos
        c = self.units[pos]
        pos += 1
        if (
            (self.unicode or self.force_unicode)
            and pos < len(self.units)
            and "\ud800" <= c <= "\udbff"
        ):
            trail = self.units[pos]
            if "\udc00" <= trail <= "\udfff":
                c = chr(0x10000 + ((ord(c) - 0xD800) << 10) + ord(trail) - 0xDC00)
                pos += 1
        if move:
            self.next_pos = pos
        return c

    def at(self, *chars: str) -> bool:
        return self.cur in chars

    def peek(self) -> str:
        return self.read(False) if self.next_pos < len(self.units) else _END

    def advance(self, dist: int = 1) -> None:
        self.next_pos += dist - 1
        if self.next_pos < len(self.units):
            self.cur = self.read(True)
        else:
            self.cur = _END
            self.next_pos = len(self.units) + 1
            self.has_more = False

    def position(self) -> int:
        return self.next_pos - 1

    def reset(self, pos: int) -> None:
        self.next_pos = pos
        self.has_more = pos < len(self.units)
        self.advance()

    def rewind(self) -> None:
        if self.has_more:
            self.advance(-2 if ord(self.cur) > 0xFFFF else -1)

    # The pattern.

    def parse(self) -> None:
        groups: list[tuple[str, str | None]] = []  # the open groups: kind, name
        while True:
            c = self.cur
            closed = None
            if c == _END:
                if groups:
                    raise _Refused("Unterminated group")
                break
            if c == ")":
                if not groups:
                    raise _Refused("Unmatched ')'")
                self.advance()
                closed, name = groups.pop()
                if name is not None:
                    if name in self.names:
                        raise _Refused("Duplicate capture group name")
                    self.names.add(name)
            elif c in ("|", "^", "$"):
                self.advance()
                continue
            elif c in ("*", "+", "?"):
                raise _Refused("Nothing to repeat")
            elif c == "(":
                groups.append(self.open_group())
                continue
            elif c == "[":
                self.character_class()
            elif c == "\\":
                if not self.atom_escape():
                    continue
            elif c in ("{", "}", "]"):
                if c == "{" and self.interval() is not None:
                    raise _Refused("Nothing to repeat")
                if self.unicode:
                    raise _Refused("Lone quantifier brackets")
                self.advance()
            else:
                self.advance()

            if self.at("*", "+", "?"):
                self.advance()
            elif self.at("{"):
                bounds = self.interval()
                if bounds is None:
                    if self.unicode:
                        raise _Refused("Incomplete quantifier")
                    continue
                if bounds[1] < bounds[0]:
                    raise _Refused("numbers out of order in {} quantifier")
            else:
                continue
            if self.at("?"):
                self.advance()
            if closed == "lookbehind" or (closed == "lookahead" and self.unicode):
                raise _Refused("Invalid quantifier")
        # A reference inside the group it names isn't kept by V8; keeping it changes nothing
        # here, as that group's name is known once the group closes.
        if any(name not in self.names for name in self.references):
            raise _Refused("Invalid named capture referenced")

    def open_group(self) -> tuple[str, str | None]:
        self.advance()
        kind = "capture"
        named = False
        if self.at("?"):
            after = self.peek()
            if after in (":", "=", "!"):
                self.advance(2)
                kind = "group" if after == ":" else "lookahead"
            elif after == "<":
                self.advance()
                if self.peek() in ("=", "!"):
                    self.advance(2)
                    kind = "lookbehind"
                else:
                    named = True
                    self.has_named = True
                    self.advance()
            else:  # modifiers, `(?i:…)`, are off in Node 22
                raise _Refused("Invalid group")
        name = None
        if kind == "capture":
            if self.captures_started >= _MAX_CAPTURES:
                raise _Refused("Too many captures")
            self.captures_started += 1
            if named:
                name = self.group_name()
        return kind, name

    def scan_for_captures(self, in_class: bool) -> None:
        """Counts the groups from here on, and whether one is named, without reading them."""
        saved = self.position()
        count = self.captures_started
        if in_class:
            while (c := self.cur) != _END:
                self.advance()
                if c == "\\":
                    self.advance()
                elif c == "]":
                    break
        while (c := self.cur) != _END:
            self.advance()
            if c == "\\":
                self.advance()
            elif c == "[":
                while (d := self.cur) != _END:
                    self.advance()
                    if d == "\\":
                        self.advance()
                    elif d == "]":
                        break
            elif c == "(":
                if self.at("?"):
                    self.advance()
                    if not self.at("<"):
                        continue
                    self.advance()
                    if self.at("=", "!"):
                        continue
                    self.has_named = True
                count += 1
        self.capture_count = count
        self.scanned = True
        self.reset(saved)

    def has_named_captures(self, in_class: bool) -> bool:
        if not (self.has_named or self.scanned):
            self.scan_for_captures(in_class)
        return self.has_named

    def interval(self) -> tuple[int, int] | None:
        """`{n}`, `{n,}` or `{n,m}` read, or `None` with nothing read."""
        start = self.position()
        self.advance()
        if not "0" <= self.cur <= "9":
            self.reset(start)
            return None
        low = self.number()
        if self.at("}"):
            self.advance()
            return low, low
        if not self.at(","):
            self.reset(start)
            return None
        self.advance()
        if self.at("}"):
            self.advance()
            return low, _INFINITY
        high = self.number()
        if not self.at("}"):
            self.reset(start)
            return None
        self.advance()
        return low, high

    def number(self) -> int:
        value = 0
        while "0" <= self.cur <= "9":
            value = min(10 * value + ord(self.cur) - 0x30, _INFINITY)
            self.advance()
        return value

    # Escapes.

    def atom_escape(self) -> bool:
        """Reads an escape outside a class; `False` for `\\b` and `\\B`, which take no
        quantifier."""
        after = self.peek()
        if after == _END:
            raise _Refused("\\ at end of pattern")
        if "1" <= after <= "9":
            if self.back_reference():
                return True
            if self.unicode:
                raise _Refused("Invalid escape")
            if after in ("8", "9"):
                self.advance(2)
                return True
        if "0" <= after <= "7":
            self.advance()
            if self.unicode and "0" <= self.peek() <= "9":
                raise _Refused("Invalid decimal escape")
            self.octal()
        elif after in ("b", "B"):
            self.advance(2)
            return False
        elif after in _CLASS_ESCAPES:
            self.advance(2)
        elif after in ("p", "P"):
            self.advance(2)
            if self.unicode and not self.property():
                raise _Refused("Invalid property name")
        elif after == "k" and (self.has_named_captures(False) or self.unicode):
            self.advance(2)
            if not self.at("<"):
                raise _Refused("Invalid named reference")
            self.advance()
            self.references.append(self.group_name())
        else:
            self.character_escape(False)
        return True

    def back_reference(self) -> bool:
        """Reads `\\1`…, if there are that many groups; else reads nothing."""
        start = self.position()
        value = ord(self.peek()) - 0x30
        self.advance(2)
        while "0" <= self.cur <= "9":
            value = 10 * value + ord(self.cur) - 0x30
            if value > _MAX_CAPTURES:
                self.reset(start)
                return False
            self.advance()
        if value > self.captures_started:
            if not self.scanned:
                self.scan_for_captures(False)
            if value > self.capture_count:
                self.reset(start)
                return False
        return True

    def character_escape(self, in_class: bool) -> int:
        self.advance()
        c = self.cur
        if c in _CONTROL:
            self.advance()
            return _CONTROL[c]
        if c == "c":
            letter = self.peek()
            code = ord(letter) if letter != _END else 0
            if 0x41 <= (code & ~0x20) <= 0x5A or (
                in_class and not self.unicode and (0x30 <= code <= 0x39 or code == 0x5F)
            ):
                self.advance(2)
                return code & 0x1F
            if self.unicode:
                raise _Refused("Invalid Unicode escape")
            return 0x5C  # the backslash alone; the `c` is read next
        if c == "0" and not "0" <= self.peek() <= "9":
            self.advance()
            return 0
        if "0" <= c <= "7":
            if self.unicode:
                raise _Refused("Invalid class escape")
            return self.octal()
        if c == "x":
            self.advance()
            value = self.hex(2)
            if value is None and self.unicode:
                raise _Refused("Invalid escape")
            return 0x78 if value is None else value
        if c == "u":
            self.advance()
            value = self.unicode_escape()
            if value is None and self.unicode:
                raise _Refused("Invalid Unicode escape")
            return 0x75 if value is None else value
        if self.unicode and c not in _SYNTAX:
            raise _Refused("Invalid escape")
        self.advance()
        if not self.unicode and c == "k" and self.has_named_captures(in_class):
            raise _Refused("Invalid escape")
        return ord(c)

    def octal(self) -> int:
        value = ord(self.cur) - 0x30
        self.advance()
        if "0" <= self.cur <= "7":
            value = value * 8 + ord(self.cur) - 0x30
            self.advance()
            if value < 32 and "0" <= self.cur <= "7":
                value = value * 8 + ord(self.cur) - 0x30
                self.advance()
        return value

    def hex(self, length: int) -> int | None:
        start = self.position()
        value = 0
        for _ in range(length):
            digit = _HEX.get(self.cur)
            if digit is None:
                self.reset(start)
                return None
            value = value * 16 + digit
            self.advance()
        return value

    def unicode_escape(self) -> int | None:
        """After `\\u`: `XXXX`, a surrogate pair `XXXX\\uXXXX` and `{X…}` with `u`."""
        unicode = self.unicode or self.force_unicode
        if self.at("{") and unicode:
            start = self.position()
            self.advance()
            value = self.hex_number()
            if value is not None and self.at("}"):
                self.advance()
                return value
            self.reset(start)
            return None
        value = self.hex(4)
        if value is not None and unicode and 0xD800 <= value <= 0xDBFF and self.at("\\"):
            start = self.position()
            if self.peek() == "u":
                self.advance(2)
                trail = self.hex(4)
                if trail is not None and 0xDC00 <= trail <= 0xDFFF:
                    return 0x10000 + ((value - 0xD800) << 10) + trail - 0xDC00
            self.reset(start)
        return value

    def hex_number(self) -> int | None:
        """Hex digits, read; `None` with none, or with a value over 10FFFF."""
        digit = _HEX.get(self.cur)
        if digit is None:
            return None
        value = 0
        while digit is not None:
            value = value * 16 + digit
            if value > 0x10FFFF:
                return None
            self.advance()
            digit = _HEX.get(self.cur)
        return value

    def group_name(self) -> str:
        """A group's name, `<` read: its characters to the `>`, read as with `u`."""
        self.rewind()
        name: list[str] = []
        self.force_unicode = True
        while True:
            self.advance()
            code = ord(self.cur) if self.cur != _END else -1
            if code == 0x5C and self.peek() == "u":
                self.advance(2)
                value = self.unicode_escape()
                if value is None:
                    raise _Refused("Invalid Unicode escape")
                code = value
                self.rewind()
            if code == 0x5C:
                raise _Refused("Invalid capture group name")
            if not name:
                if not _among(ID_START, code):
                    raise _Refused("Invalid capture group name")
            elif code == 0x3E:
                break
            elif not _among(ID_CONTINUE, code):
                raise _Refused("Invalid capture group name")
            name.append(chr(code))
        self.force_unicode = False
        self.advance()
        return "".join(name)

    # Classes.

    def character_class(self) -> None:
        self.advance()
        if self.at("^"):
            self.advance()
        if self.at("]"):
            self.advance()
            return
        while self.has_more and not self.at("]"):
            first, first_is_class = self.class_atom()
            if not self.at("-"):
                continue
            self.advance()
            if not self.has_more or self.at("]"):
                break
            last, last_is_class = self.class_atom()
            if first_is_class or last_is_class:
                if self.unicode:
                    raise _Refused("Invalid character class")
            elif first > last:
                raise _Refused("Range out of order in character class")
        if not self.has_more:
            raise _Refused("Unterminated character class")
        self.advance()

    def class_atom(self) -> tuple[int, bool]:
        """A class's character, or `True` for a class within it (`\\d`, `\\p{…}`)."""
        if not self.at("\\"):
            code = ord(self.cur)
            self.advance()
            return code, False
        after = self.peek()
        if after == "b" or (after == "-" and self.unicode):
            self.advance(2)
            return (0x08 if after == "b" else 0x2D), False
        if after == _END:
            raise _Refused("\\ at end of pattern")
        if after in _CLASS_ESCAPES:
            self.advance(2)
            return 0, True
        if after in ("p", "P") and self.unicode:
            self.advance(2)
            if not self.property():
                raise _Refused("Invalid property name in character class")
            return 0, True
        return self.character_escape(True), False

    def property(self) -> bool:
        """`{name}` or `{name=value}` after `\\p`, read; whether V8 knows it."""
        if not self.at("{"):
            return False
        self.advance()
        name = self.property_part("=")
        if name is None:
            return False
        value = None
        if self.at("="):
            self.advance()
            value = self.property_part("}")
            if value is None:
                return False
        self.advance()
        if value is None:
            return name in GENERAL_CATEGORIES or name in BINARY_PROPERTIES
        if name in GENERAL_CATEGORY_NAMES:
            return value in GENERAL_CATEGORIES
        return name in SCRIPT_NAMES and value in SCRIPTS

    def property_part(self, stop: str) -> str | None:
        part = ""
        while not self.at("}", stop):
            # V8 keeps a character's low 8 bits, so `Ł` (U+0141) reads as `A`.
            low = chr(ord(self.cur) & 0xFF) if self.cur != _END else _END
            if low not in _PROPERTY_CHARACTERS or self.next_pos >= len(self.units):
                return None
            part += low
            self.advance()
        return part
