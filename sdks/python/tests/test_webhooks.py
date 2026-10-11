# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`kindgi.webhooks`: Standard Webhooks signatures, held to the same cases as `@kindgi/crypto`."""

from __future__ import annotations

import base64
import json
import time
from collections.abc import Iterator, Mapping
from datetime import UTC, datetime

import pydantic
import pytest

from kindgi import webhooks
from kindgi.client import models
from kindgi.webhooks import WebhookVerificationError

# The test vector published with the Standard Webhooks specification
# (the same one `@kindgi/crypto`'s tests use).
SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
MSG_ID = "msg_p5jXN8AQM9LWM0D4loKWxJek"
TIMESTAMP = 1614265330
BODY = '{"test": 2432232314}'
SIGNATURE = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE="
HEADERS = {
    "webhook-id": MSG_ID,
    "webhook-timestamp": str(TIMESTAMP),
    "webhook-signature": SIGNATURE,
}


def at_vector() -> float:
    return float(TIMESTAMP)


def reason(secret: str, headers: Mapping[str, str], body: str | bytes = BODY) -> str:
    with pytest.raises(WebhookVerificationError) as raised:
        webhooks.verify(secret, headers, body, now=at_vector)
    return raised.value.reason


# --- sign -------------------------------------------------------------------


def test_sign_matches_the_standard_webhooks_vector() -> None:
    assert webhooks.sign(SECRET, id=MSG_ID, timestamp=TIMESTAMP, body=BODY) == SIGNATURE


def test_sign_bytes_like_the_equivalent_string() -> None:
    signed = webhooks.sign(SECRET, id=MSG_ID, timestamp=TIMESTAMP, body=BODY.encode())
    assert signed == SIGNATURE


def test_sign_once_per_secret_during_a_rotation() -> None:
    parts = webhooks.sign(
        [webhooks.generate_secret(), SECRET], id=MSG_ID, timestamp=TIMESTAMP, body=BODY
    ).split(" ")
    assert len(parts) == 2
    assert parts[1] == SIGNATURE


def test_sign_refuses_a_malformed_secret_a_bad_timestamp_and_no_secrets() -> None:
    with pytest.raises(ValueError, match="whsec_"):
        webhooks.sign("whsec_not base64!", id=MSG_ID, timestamp=TIMESTAMP, body=BODY)
    for timestamp in (-1, 1.5, True):
        with pytest.raises(ValueError, match="non-negative integer"):
            webhooks.sign(SECRET, id=MSG_ID, timestamp=timestamp, body=BODY)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="at least one secret"):
        webhooks.sign([], id=MSG_ID, timestamp=TIMESTAMP, body=BODY)


def test_signed_headers_carry_all_three() -> None:
    assert webhooks.signed_headers(SECRET, id=MSG_ID, timestamp=TIMESTAMP, body=BODY) == HEADERS


# --- verify -----------------------------------------------------------------


def test_verify_accepts_the_vector() -> None:
    verified = webhooks.verify(SECRET, HEADERS, BODY, now=at_vector)
    assert verified == webhooks.VerifiedWebhook(id=MSG_ID, timestamp=TIMESTAMP)
    assert webhooks.verify(SECRET, HEADERS, BODY.encode(), now=at_vector) == verified


class CaseInsensitiveHeaders(Mapping[str, str]):
    """Like Starlette's `Headers`: lookups ignore case, iteration keeps the sent names."""

    def __init__(self, raw: list[tuple[str, str]]) -> None:
        self._raw = raw

    def __getitem__(self, key: str) -> str:
        for name, value in self._raw:
            if name.lower() == key.lower():
                return value
        raise KeyError(key)

    def __iter__(self) -> Iterator[str]:
        return (name for name, _ in self._raw)

    def __len__(self) -> int:
        return len(self._raw)


def test_header_names_match_in_any_case_from_any_mapping() -> None:
    upper = {name.title(): value for name, value in HEADERS.items()}
    assert webhooks.verify(SECRET, upper, BODY, now=at_vector).id == MSG_ID
    raw = CaseInsensitiveHeaders([("Webhook-Id", MSG_ID), *list(HEADERS.items())[1:]])
    assert webhooks.verify(SECRET, raw, BODY, now=at_vector).id == MSG_ID


def test_a_changed_body_id_or_secret_fails() -> None:
    assert reason(SECRET, HEADERS, '{"test": 2432232315}') == "no-matching-signature"
    assert reason(SECRET, {**HEADERS, "webhook-id": "msg_other"}) == "no-matching-signature"
    assert reason(webhooks.generate_secret(), HEADERS) == "no-matching-signature"


def test_the_tolerance_holds_in_either_direction() -> None:
    for offset in (-301, 301):
        with pytest.raises(WebhookVerificationError) as raised:
            webhooks.verify(SECRET, HEADERS, BODY, now=lambda o=offset: TIMESTAMP + o)
        assert raised.value.reason == "timestamp-out-of-tolerance"
    for offset in (-300, 300.9):
        webhooks.verify(SECRET, HEADERS, BODY, now=lambda o=offset: TIMESTAMP + o)
    webhooks.verify(SECRET, HEADERS, BODY, tolerance_seconds=3600, now=lambda: TIMESTAMP + 3600)


def test_missing_or_empty_headers_and_a_malformed_timestamp_are_reported() -> None:
    without_signature = {k: v for k, v in HEADERS.items() if k != "webhook-signature"}
    assert reason(SECRET, without_signature) == "missing-headers"
    assert reason(SECRET, {**HEADERS, "webhook-id": ""}) == "missing-headers"
    for bad in ("16142e5", "-1614265330", "١٦١٤٢٦٥٣٣٠", "1" * 16):
        assert reason(SECRET, {**HEADERS, "webhook-timestamp": bad}) == "invalid-timestamp"


def test_a_malformed_secret_is_reported() -> None:
    for secret in ("whsec_", "whsec_not base64!", "", "whsec_A"):
        assert reason(secret, HEADERS) == "invalid-secret"


def test_either_secret_verifies_during_a_rotation() -> None:
    new = webhooks.generate_secret()
    rotated = webhooks.signed_headers([new, SECRET], id=MSG_ID, timestamp=TIMESTAMP, body=BODY)
    for secret in (new, SECRET):
        assert webhooks.verify(secret, rotated, BODY, now=at_vector).id == MSG_ID


def test_unknown_versions_and_malformed_signatures_are_skipped() -> None:
    signature = f"v1a,AAAA v1 v1,not-base64! v1,{base64.b64encode(b'x' * 32).decode()} {SIGNATURE}"
    assert webhooks.verify(SECRET, {**HEADERS, "webhook-signature": signature}, BODY, now=at_vector)
    only_unknown = {**HEADERS, "webhook-signature": SIGNATURE.replace("v1,", "v2,")}
    assert reason(SECRET, only_unknown) == "no-matching-signature"


def test_verify_uses_the_clock_by_default() -> None:
    now = int(time.time())
    headers = webhooks.signed_headers(SECRET, id=MSG_ID, timestamp=now, body=BODY)
    assert webhooks.verify(SECRET, headers, BODY).timestamp == now


# --- secrets ----------------------------------------------------------------


def test_is_strong_secret_wants_24_bytes_with_or_without_the_prefix() -> None:
    b24 = base64.b64encode(bytes([7] * 24)).decode()
    b23 = base64.b64encode(bytes([7] * 23)).decode()
    assert webhooks.is_strong_secret(f"whsec_{b24}")
    assert webhooks.is_strong_secret(b24)
    assert not webhooks.is_strong_secret(f"whsec_{b23}")
    assert webhooks.is_strong_secret(webhooks.generate_secret())
    assert not webhooks.is_strong_secret("password123")
    assert not webhooks.is_strong_secret("whsec_")


def test_generate_secret_is_whsec_and_32_random_bytes() -> None:
    a, b = webhooks.generate_secret(), webhooks.generate_secret()
    assert a.startswith(webhooks.SECRET_PREFIX)
    assert len(base64.b64decode(a.removeprefix(webhooks.SECRET_PREFIX))) == 32
    assert a != b


# --- parse_event ------------------------------------------------------------

RUN_FINISHED = {
    "id": "5c6f0d2e-0000-4000-8000-000000000001",
    "type": "run.finished",
    "createdAt": "2026-10-02T00:00:00.000Z",
    "data": {
        "run": {
            "id": "2b1e9c4a-0000-4000-8000-000000000002",
            "projectId": "7d3f5a10-0000-4000-8000-000000000003",
            "flowId": "acme.order-review",
            "flowVersion": "1.0.0",
            "status": "failed",
            "dryRun": False,
            "failureMessage": "the model call failed",
            "createdAt": "2026-10-01T23:59:00.000Z",
            "completedAt": "2026-10-02T00:00:00.000Z",
        }
    },
}


def test_parse_event_reads_run_finished() -> None:
    event = webhooks.parse_event(json.dumps(RUN_FINISHED).encode())
    assert isinstance(event, models.RunFinishedEvent)
    assert event.data.run.flow_id == "acme.order-review"
    assert event.data.run.status == "failed"
    assert event.created_at == datetime(2026, 10, 2, tzinfo=UTC)


def test_parse_event_reads_the_test_event() -> None:
    body = {
        "id": "evt-test",
        "type": "webhook.test",
        "createdAt": "2026-10-02T00:00:00.000Z",
        "data": {"endpointId": "ep-1"},
    }
    event = webhooks.parse_event(json.dumps(body))
    assert isinstance(event, models.WebhookTestEvent)
    assert event.data.endpoint_id == "ep-1"


def test_parse_event_reads_an_improvement_pass_finished() -> None:
    body = {
        "id": "evt-pass",
        "type": "improvement-pass.finished",
        "createdAt": "2026-10-07T12:00:00.000Z",
        "data": {
            "pass": {
                "id": "8a1e9c4a-0000-4000-8000-000000000004",
                "agentId": "acme.scorer",
                "fromVersion": "1.0.0",
                "scope": {"kind": "tenant"},
                "suiteId": "acme.scorer.improve",
                "tiers": ["settings"],
                "objective": "weightedYesShare",
                "classWeights": "restricted-only",
                "budget": {"maxCostUsd": 5, "maxCandidates": 30},
                "requestedBy": "service:schedule",
                "status": "completed",
                "candidatesEvaluated": 7,
                "costUsd": "0.12",
                "outcome": {
                    "kind": "proposed",
                    "proposalId": "9b2e9c4a-0000-4000-8000-000000000005",
                },
                "trigger": {
                    "triggerId": "1c3e9c4a-0000-4000-8000-000000000006",
                    "fireId": "2d4e9c4a-0000-4000-8000-000000000007",
                },
                "createdAt": "2026-10-07T11:00:00.000Z",
                "updatedAt": "2026-10-07T12:00:00.000Z",
                "finishedAt": "2026-10-07T12:00:00.000Z",
            }
        },
    }
    event = webhooks.parse_event(json.dumps(body))
    assert isinstance(event, models.ImprovementPassFinishedEvent)
    assert event.data.pass_.agent_id == "acme.scorer"
    assert event.data.pass_.trigger is not None
    assert event.data.pass_.trigger.trigger_id == "1c3e9c4a-0000-4000-8000-000000000006"


def test_parse_event_reads_an_approval_requested() -> None:
    body = {
        "id": "evt-approval",
        "type": "approval.requested",
        "createdAt": "2026-10-09T12:00:00.000Z",
        "data": {
            "approval": {
                "approvalId": "3e5e9c4a-0000-4000-8000-000000000008",
                "projectId": "4f6e9c4a-0000-4000-8000-000000000009",
                "requiredRole": "senior",
                "title": "Refund over the limit",
                "createdAt": "2026-10-09T12:00:00.000Z",
                "url": "https://kindgi.example.com/console/approvals/3e5e9c4a-0000-4000-8000-000000000008",
            }
        },
    }
    event = webhooks.parse_event(json.dumps(body))
    assert isinstance(event, models.ApprovalRequestedEvent)
    assert event.data.approval.required_role == "senior"


def test_parse_event_refuses_an_unknown_type() -> None:
    with pytest.raises(pydantic.ValidationError):
        webhooks.parse_event(json.dumps({**RUN_FINISHED, "type": "run.started"}))


# --- interoperability with the reference implementation, both ways ----------


def test_the_reference_library_verifies_what_sign_produces() -> None:
    standardwebhooks = pytest.importorskip("standardwebhooks")
    secret = webhooks.generate_secret()
    body = json.dumps(RUN_FINISHED)
    headers = webhooks.signed_headers(secret, id="evt-1", timestamp=int(time.time()), body=body)
    assert standardwebhooks.Webhook(secret).verify(body, headers) == RUN_FINISHED


def test_verify_accepts_what_the_reference_library_signs() -> None:
    standardwebhooks = pytest.importorskip("standardwebhooks")
    secret = webhooks.generate_secret()
    now = datetime.now(UTC)
    body = '{"hello":"world"}'
    signature = standardwebhooks.Webhook(secret).sign("evt-2", now, body)
    headers = {
        "webhook-id": "evt-2",
        "webhook-timestamp": str(int(now.timestamp())),
        "webhook-signature": signature,
    }
    assert webhooks.verify(secret, headers, body).id == "evt-2"
