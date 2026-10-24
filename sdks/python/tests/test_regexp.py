# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kindgi._regexp import regexp_problem


def test_the_u_flag_refuses_what_plain_mode_reads_as_a_letter() -> None:
    assert regexp_problem(r"\a", unicode=False) is None
    assert regexp_problem(r"\a", unicode=True) == "Invalid escape"
    assert regexp_problem("a{1", unicode=False) is None
    assert regexp_problem("a{1", unicode=True) == "Incomplete quantifier"
    assert regexp_problem("]", unicode=True) == "Lone quantifier brackets"
    assert regexp_problem(r"\p{letter}", unicode=False) is None
    assert regexp_problem(r"\p{letter}", unicode=True) == "Invalid property name"


def test_plain_mode_still_refuses_structure() -> None:
    assert regexp_problem("(a", unicode=False) == "Unterminated group"
    assert regexp_problem("a)", unicode=False) == "Unmatched ')'"
    assert regexp_problem("a**", unicode=False) == "Nothing to repeat"
    assert regexp_problem("a{2,1}", unicode=False) == "numbers out of order in {} quantifier"
    assert regexp_problem("[z-a]", unicode=False) == "Range out of order in character class"
    assert regexp_problem("(?i:a)", unicode=False) == "Invalid group"
    assert regexp_problem("a\\", unicode=False) == "\\ at end of pattern"


def test_a_named_group_makes_k_a_reference_in_either_mode() -> None:
    assert regexp_problem(r"\k<a>", unicode=False) is None
    assert regexp_problem(r"\k<a>", unicode=True) == "Invalid named capture referenced"
    assert regexp_problem(r"(?<b>.)\k<a>", unicode=False) == "Invalid named capture referenced"
    assert regexp_problem(r"(?<a>.)\k", unicode=False) == "Invalid named reference"
    assert regexp_problem(r"(?<a>.)[\k]", unicode=False) == "Invalid escape"


def test_references_are_checked_after_the_rest() -> None:
    assert regexp_problem(r"\k<a>(?<a>.)", unicode=True) is None
    assert regexp_problem(r"(?<a>.)\k<b>(", unicode=True) == "Unterminated group"


def test_a_repeated_name_is_refused_once_both_groups_close() -> None:
    assert regexp_problem("(?<a>.)|(?<a>.)", unicode=False) == "Duplicate capture group name"
    assert regexp_problem("(?<a>.)(?<a>.", unicode=False) == "Unterminated group"


def test_only_the_u_flag_refuses_a_repeated_lookahead() -> None:
    assert regexp_problem("(?=a)*", unicode=False) is None
    assert regexp_problem("(?=a)*", unicode=True) == "Invalid quantifier"
    assert regexp_problem("(?<=a)*", unicode=False) == "Invalid quantifier"


def test_the_u_flag_reads_a_surrogate_pair_as_one_character() -> None:
    assert regexp_problem("[😀-😁]", unicode=True) is None
    assert regexp_problem("[😀-😁]", unicode=False) == "Range out of order in character class"
    # A group name is read by code points in either mode.
    assert regexp_problem("(?<𝒜>.)", unicode=False) is None


def test_a_property_name_is_read_by_the_low_byte_of_each_character() -> None:
    # U+0141 ends in 0x41 ("A"), so this is \p{Any}; U+0175 ends in 0x75 ("u"), so \p{Lu}.
    assert regexp_problem(r"\p{Łny}", unicode=True) is None
    assert regexp_problem(r"\p{Lŵ}", unicode=True) is None
    assert regexp_problem(r"\p{LĀ}", unicode=True) == "Invalid property name"


def test_capture_groups_stop_at_32767() -> None:
    assert regexp_problem("()" * 32767, unicode=True) is None
    assert regexp_problem("()" * 32768, unicode=True) == "Too many captures"
    assert regexp_problem("()" * 32768, unicode=False) == "Too many captures"


# The regular-expression test vectors (packages/specs/test-vectors/README.md): Python's answer to
# each source, with the u flag and without, is Node's, word for word.
_VECTORS = Path(__file__).resolve().parents[3] / "packages/specs/test-vectors/regexp-syntax"
_CORPUS: dict[str, str | list[str | list[str | int]]] = json.loads(
    (_VECTORS / "corpus.json").read_text("utf-8")
)
_ANSWERS: dict[str, dict[str, str | None]] = json.loads(
    (_VECTORS / "answers.json").read_text("utf-8")
)


def _source(value: str | list[str | list[str | int]]) -> str:
    if isinstance(value, str):
        return value
    return "".join(part if isinstance(part, str) else str(part[0]) * int(part[1]) for part in value)


def test_the_regexp_corpus_has_an_answer_for_each_case() -> None:
    assert list(_CORPUS) == list(_ANSWERS)


def test_the_regexp_corpus_gives_every_reason() -> None:
    plain = {
        "Unterminated group",
        "Unmatched ')'",
        "Invalid group",
        "Invalid quantifier",
        "numbers out of order in {} quantifier",
        "Nothing to repeat",
        "\\ at end of pattern",
        "Invalid capture group name",
        "Invalid Unicode escape",
        "Duplicate capture group name",
        "Invalid named capture referenced",
        "Invalid named reference",
        "Invalid escape",
        "Range out of order in character class",
        "Unterminated character class",
        "Too many captures",
    }
    unicode = plain | {
        "Lone quantifier brackets",
        "Incomplete quantifier",
        "Invalid decimal escape",
        "Invalid character class",
        "Invalid class escape",
        "Invalid property name in character class",
        "Invalid property name",
    }
    assert {a["plain"] for a in _ANSWERS.values()} - {None} == plain
    assert {a["u"] for a in _ANSWERS.values()} - {None} == unicode


@pytest.mark.parametrize("name", list(_CORPUS))
def test_regexp_answers_as_node_does(name: str) -> None:
    source = _source(_CORPUS[name])
    assert regexp_problem(source, unicode=True) == _ANSWERS[name]["u"]
    assert regexp_problem(source, unicode=False) == _ANSWERS[name]["plain"]
