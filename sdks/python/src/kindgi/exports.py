# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""Verify the signed exports Kindgi produces: an approval's audit bundle,
a run's provenance, compliance evidence.

Each export is one envelope: `bundle` is base64 of the exact bytes that
were signed (the body, as sorted-key JSON), `signature` is base64 of the
signature over those bytes, and `publicKey` is the signing key's public
half (PEM). Verifying checks those bytes; nothing is re-serialized.

Two algorithms: `ed25519`, and `ecdsa-p256-sha256` (its signature IEEE
P1363 `r‖s`, 64 bytes). Any other is refused, naming it, so a newer one
fails loudly here, never silently.

The export's own `publicKey` only proves the bytes weren't changed. Pass
`trusted_keys` (the `publicKeyPem` values from `GET /v1/export-signing-keys`,
or a key you pinned) to know who signed them.

    from kindgi import exports

    checked = exports.verify_signed_export(envelope, trusted_keys=[pinned_pem])
    if not checked.valid:
        raise SystemExit("; ".join(checked.issues))
    body = checked.body

Verifying needs the `cryptography` package: `pip install 'kindgi[verify]'`.
This is the Python counterpart of `verifySignedExport` in `@kindgi/client`.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

__all__ = ["SIGNED_EXPORT_ALGORITHMS", "SignedExportVerification", "verify_signed_export"]

SIGNED_EXPORT_ALGORITHMS: tuple[str, ...] = ("ed25519", "ecdsa-p256-sha256")
"""The algorithms `verify_signed_export` checks."""

_INSTALL = (
    "Verifying a signed export needs the `cryptography` package: pip install 'kindgi[verify]'."
)


@dataclass(frozen=True)
class SignedExportVerification:
    """What `verify_signed_export` found."""

    valid: bool
    """The signature checks out (and, with `trusted_keys`, the key is one of them)."""
    signing_key_id: str
    checked_against: Literal["trusted-keys", "its-own-key"]
    issues: tuple[str, ...] = field(default=())
    """What failed, in words. Empty when `valid`."""
    body: Mapping[str, Any] | None = None
    """The signed body, parsed: present when the signature checks out."""


def verify_signed_export(
    envelope: Mapping[str, Any],
    *,
    trusted_keys: Sequence[str] | None = None,
) -> SignedExportVerification:
    """Verify a signed export's signature, and its key when `trusted_keys` is given.

    `envelope` is the export as the API answered it (a dict). Raises
    `ImportError` naming `kindgi[verify]` when `cryptography` isn't installed.
    """
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
        from cryptography.hazmat.primitives.serialization import load_pem_public_key
    except ImportError as err:  # pragma: no cover - exercised without the extra
        raise ImportError(_INSTALL) from err

    key_id = str(envelope.get("signingKeyId", ""))
    against: Literal["trusted-keys", "its-own-key"] = (
        "trusted-keys" if trusted_keys is not None else "its-own-key"
    )
    issues: list[str] = []

    def fail() -> SignedExportVerification:
        return SignedExportVerification(
            valid=False, signing_key_id=key_id, checked_against=against, issues=tuple(issues)
        )

    algorithm = envelope.get("algorithm")
    if algorithm not in SIGNED_EXPORT_ALGORITHMS:
        known = ", ".join(SIGNED_EXPORT_ALGORITHMS)
        issues.append(
            f'algorithm "{algorithm}" isn\'t one this verifier knows ({known}): '
            "a newer verifier may check it"
        )
    if envelope.get("canonicalization") != "sorted-key-json":
        issues.append(
            f'canonicalization "{envelope.get("canonicalization")}" isn\'t sorted-key-json'
        )
    pem = str(envelope.get("publicKey", ""))
    if trusted_keys is not None and not any(_same_pem(t, pem) for t in trusted_keys):
        issues.append(f'it was signed with key "{key_id}", which isn\'t one you trust')
    if issues:
        return fail()

    try:
        data = base64.b64decode(str(envelope.get("bundle", "")), validate=True)
        signature = base64.b64decode(str(envelope.get("signature", "")), validate=True)
        key = load_pem_public_key(pem.encode())
        if algorithm == "ed25519":
            if not isinstance(key, Ed25519PublicKey):
                issues.append("its public key isn't an Ed25519 key")
                return fail()
            key.verify(signature, data)
        else:
            if not isinstance(key, ec.EllipticCurvePublicKey) or key.curve.name != "secp256r1":
                issues.append("its public key isn't an EC P-256 key")
                return fail()
            if len(signature) != 64:
                issues.append(f"its signature is {len(signature)} bytes, not P1363's 64")
                return fail()
            r = int.from_bytes(signature[:32], "big")
            s = int.from_bytes(signature[32:], "big")
            key.verify(encode_dss_signature(r, s), data, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature:
        issues.append(
            "the signature doesn't match the bundle: it was changed, or signed with another key"
        )
        return fail()
    except (ValueError, TypeError, binascii.Error) as err:
        issues.append(f"it can't be checked: {err}")
        return fail()

    body = json.loads(data.decode("utf-8"))
    # The envelope's own exportedAt isn't signed; the body's is.
    if "exportedAt" in body and body["exportedAt"] != envelope.get("exportedAt"):
        outer, signed = envelope.get("exportedAt"), body["exportedAt"]
        issues.append(f"the envelope's exportedAt ({outer}) isn't the signed one ({signed})")
        return fail()
    return SignedExportVerification(
        valid=True, signing_key_id=key_id, checked_against=against, body=body
    )


def _same_pem(a: str, b: str) -> bool:
    return re.sub(r"\s+", "", a) == re.sub(r"\s+", "", b)
