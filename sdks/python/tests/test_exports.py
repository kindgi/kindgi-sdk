# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""kindgi.exports.verify_signed_export: a signed export's signature over the
bytes shipped, and its key against the keys you trust."""

from __future__ import annotations

import base64
import json

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
