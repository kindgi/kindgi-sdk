# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""kindgi.exports.verify_signed_export: a signed export's signature over the
bytes shipped, and its key against the keys you trust."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from kindgi import exports


def _pem(key: Ed25519PrivateKey) -> str:
    return key.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo).decode()


def _signed(body: dict[str, object] | None = None) -> tuple[dict[str, object], str]:
    """An export as the API answers one, signed with a fresh key."""
    key = Ed25519PrivateKey.generate()
    exported_at = "2026-10-08T00:00:00.000Z"
    full = {**(body or {}), "bundleSchemaVersion": "1.2.0", "exportedAt": exported_at}
    data = json.dumps(full, sort_keys=True, separators=(",", ":")).encode()
    envelope: dict[str, object] = {
        "kind": "provenance",
        "runId": "r-1",
        "bundle": base64.b64encode(data).decode(),
        "bundleSchemaVersion": "1.2.0",
        "algorithm": "ed25519",
        "signingKeyId": "ex_testkey0000000",
        "signature": base64.b64encode(key.sign(data)).decode(),
        "publicKey": _pem(key),
        "canonicalization": "sorted-key-json",
        "exportedAt": exported_at,
    }
    return envelope, _pem(key)


def test_a_signed_export_verifies_against_its_own_key_and_returns_the_body() -> None:
    envelope, _ = _signed({"runId": "r-1"})
    checked = exports.verify_signed_export(envelope)
    assert checked.valid
    assert checked.checked_against == "its-own-key"
    assert checked.body is not None and checked.body["runId"] == "r-1"


def test_against_trusted_keys_one_verifies_and_a_stranger_is_refused() -> None:
    envelope, pem = _signed()
    other = _pem(Ed25519PrivateKey.generate())
    assert exports.verify_signed_export(envelope, trusted_keys=[other, pem]).valid
    refused = exports.verify_signed_export(envelope, trusted_keys=[other])
    assert not refused.valid
    assert "isn't one you trust" in " ".join(refused.issues)


def test_a_changed_byte_and_a_changed_envelope_exported_at_fail() -> None:
    envelope, _ = _signed({"runId": "r-1"})
    data = base64.b64decode(str(envelope["bundle"])).replace(b"r-1", b"r-2")
    changed = exports.verify_signed_export({**envelope, "bundle": base64.b64encode(data).decode()})
    assert not changed.valid
    assert "doesn't match the bundle" in " ".join(changed.issues)
    moved = exports.verify_signed_export({**envelope, "exportedAt": "2027-01-01T00:00:00.000Z"})
    assert not moved.valid
    assert "isn't the signed one" in " ".join(moved.issues)


_VECTORS = Path(__file__).resolve().parents[3] / "packages/specs/test-vectors/signed-export"


def _vector(name: str) -> dict[str, Any]:
    return json.loads((_VECTORS / f"{name}.json").read_text())


@pytest.mark.parametrize("name", ["ed25519", "ecdsa-p256-sha256"])
def test_shared_vector_valid_checks_out_and_tampered_fails(name: str) -> None:
    v = _vector(name)
    good = exports.verify_signed_export(v["valid"], trusted_keys=[v["publicKeyPem"]])
    assert good.valid, good.issues
    assert good.checked_against == "trusted-keys"
    assert good.body is not None and good.body["bundleSchemaVersion"] == "2.0.0"
    bad = exports.verify_signed_export(v["tampered"], trusted_keys=[v["publicKeyPem"]])
    assert not bad.valid
    assert "doesn't match the bundle" in " ".join(bad.issues)


def test_shared_vector_unknown_algorithm_is_refused_naming_it() -> None:
    result = exports.verify_signed_export(_vector("unknown-algorithm")["refused"])
    assert not result.valid
    known = ", ".join(exports.SIGNED_EXPORT_ALGORITHMS)
    assert result.issues[0] == (
        f'algorithm "ecdsa-p384-sha384" isn\'t one this verifier knows ({known}): '
        "a newer verifier may check it"
    )


def test_exports_made_by_kindgi_014_verify_and_an_off_stamp_reports_the_signed_time() -> None:
    v = _vector("kindgi-0.1.4")
    trusted = [v["publicKeyPem"]]
    same = exports.verify_signed_export(v["auditBundle"], trusted_keys=trusted)
    assert same.valid, same.issues
    assert same.notes == ()
    differ = exports.verify_signed_export(v["auditBundleStampsDiffer"], trusted_keys=trusted)
    assert differ.valid, differ.issues
    assert differ.notes == (v["note"],)
    provenance = exports.verify_signed_export(v["provenance"], trusted_keys=trusted)
    assert provenance.valid, provenance.issues
    assert provenance.notes == ()


def test_the_014_leniency_is_that_formats_alone() -> None:
    v = _vector("ed25519")
    moved = {**v["valid"], "exportedAt": "2027-01-01T00:00:00.000Z"}
    assert not exports.verify_signed_export(moved).valid
    claimed = exports.verify_signed_export({**moved, "bundleSchemaVersion": 1})
    assert not claimed.valid
    assert "isn't the signed one" in " ".join(claimed.issues)
    old = _vector("kindgi-0.1.4")["auditBundleStampsDiffer"]
    as_bool = exports.verify_signed_export({**old, "bundleSchemaVersion": True})
    assert not as_bool.valid
