# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`kindgi.client` against a mock transport: requests, answers, errors, retries, streams."""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from kindgi.client import (
    AsyncKindgi,
    AuthError,
    ConflictError,
    GuardrailViolationError,
    InvalidRequestError,
    Kindgi,
    NetworkError,
    NotFoundError,
    RateLimitedError,
    ServerError,
    apaginate,
    models,
    paginate,
)

RUN = {
    "id": "6ccd0eca-40b4-4b86-b8f5-24b0900dddda",
    "tenantId": "f531e37d-f29f-463c-81d2-ffad65e4d4e9",
    "flowId": "live.shout-flow",
    "flowVersion": "1.0.0",
    "status": "completed",
    "dryRun": False,
    "createdAt": "2026-10-01T14:07:42.379Z",
    "updatedAt": "2026-10-01T14:07:43.043Z",
    "output": {"shouted": "HI!"},
}


def event(seq: int) -> dict[str, Any]:
    return {
        "eventId": f"e{seq}",
        "runId": RUN["id"],
        "tenantId": RUN["tenantId"],
        "timestamp": "2026-10-01T14:07:42.379Z",
        "kind": "run.started",
        "sequence": seq,
    }


Handler = Callable[[httpx.Request], httpx.Response]


def client(handler: Handler, **kwargs: Any) -> tuple[Kindgi, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    http = httpx.Client(transport=httpx.MockTransport(record))
    return Kindgi("http://kindgi.test/", token="kgi_bt_test", http_client=http, **kwargs), seen


def error(status: int, code: str, **extra: Any) -> httpx.Response:
    return httpx.Response(status, json={"error": {"code": code, "message": f"{code}!", **extra}})


def test_a_call_sends_the_body_on_the_wire_and_parses_the_answer() -> None:
    api, seen = client(lambda r: httpx.Response(201, json=RUN))
    run = api.runs.start(flow="live.shout-flow", input={"message": "hi"}, options={"wait": False})
    assert isinstance(run, models.Run)
    assert (
        run.flow_id == "live.shout-flow"
        and run.status == "completed"
        and run.output == {"shouted": "HI!"}
    )
    (request,) = seen
    assert request.method == "POST" and request.url == "http://kindgi.test/v1/runs"
    assert json.loads(request.content) == {
        "flow": "live.shout-flow",
        "input": {"message": "hi"},
        "options": {"wait": False},
    }
    assert request.headers["authorization"] == "Bearer kgi_bt_test"
    assert request.headers["idempotency-key"]  # generated: the call is safe to retry


def test_a_run_started_without_waiting_is_pending_and_carries_its_token() -> None:
    # What `options.wait: False` answers: 202 and the run before it has run.
    pending = {k: v for k, v in RUN.items() if k != "output"} | {
        "status": "pending",
        "publicAccessToken": "kgi_pt_payload.signature",
        "publicAccessTokenExpiresAt": "2026-10-01T14:22:42.000Z",
    }
    api, _ = client(lambda r: httpx.Response(202, json=pending))
    run = api.runs.start(flow="live.shout-flow", input={}, options={"wait": False})
    assert run.status == "pending"
    assert run.public_access_token == "kgi_pt_payload.signature"


def test_a_body_as_a_mapping_or_a_model() -> None:
    api, seen = client(lambda r: httpx.Response(201, json=RUN))
    api.runs.start({"agent": "live.shouter", "input": {"userMessage": "hi"}}, idempotency_key="k-1")
    body = models.StartRunBody1(agent="live.shouter", input={"userMessage": "hi"})
    api.runs.start(body)
    assert [json.loads(r.content) for r in seen] == [
        {"agent": "live.shouter", "input": {"userMessage": "hi"}}
    ] * 2
    assert seen[0].headers["idempotency-key"] == "k-1"
    with pytest.raises(TypeError, match="not both"):
        api.runs.start({"agent": "a", "input": {}}, flow="f")


def test_a_field_named_for_a_keyword_takes_a_trailing_underscore() -> None:
    # `from` is a Python keyword: `from_=` sends it, as does a mapping.
    derived = {
        "id": "acme.intake",
        "version": "1.4.1",
        "name": "Intake",
        "instructions": {"prompt": "acme.intake-prompt", "version": "^1.0.0"},
        "capabilities": [],
        "tools": [],
        "retrieval": [],
        "guardrails": [],
        "derivedFrom": {"version": "1.4.0", "reason": "edited", "by": "user:u-1"},
    }
    api, seen = client(lambda r: httpx.Response(201, json=derived))
    pins = {"prompts": {"acme.intake-prompt": "1.1.0"}}
    agent = api.agents.derive_version("acme.intake", from_="1.4.0", pins=pins)
    api.agents.derive_version("acme.intake", {"from": "1.4.0", "pins": pins})
    assert agent.derived_from is not None and agent.derived_from.reason == "edited"
    assert [r.url for r in seen] == ["http://kindgi.test/v1/agents/acme.intake/versions"] * 2
    assert [json.loads(r.content) for r in seen] == [{"from": "1.4.0", "pins": pins}] * 2


def test_path_and_query_parameters() -> None:
    page = {"data": [], "hasMore": False}
    api, seen = client(
        lambda r: httpx.Response(200, json=page if r.url.path == "/v1/runs" else RUN)
    )
    api.runs.get("a/b c")
    api.runs.list(limit=5, top_level=True)
    assert seen[0].url.raw_path == b"/v1/runs/a%2Fb%20c"
    assert dict(seen[1].url.params) == {"limit": "5", "topLevel": "true"}


def test_eval_suites_unregister_names_the_call_as_the_other_resources_do() -> None:
    # `eval_suites.unregister`, as `agents.unregister`: the same call as
    # `eval_suites.versions.unregister`.
    answer = {"suiteId": "acme.set", "version": "1.0.0", "unregistered": True}
    api, seen = client(lambda r: httpx.Response(200, json=answer))
    api.eval_suites.unregister("acme.set", "1.0.0")
    api.eval_suites.versions.unregister("acme.set", "1.0.0")
    assert [(r.method, r.url.path) for r in seen] == [
        ("POST", "/v1/eval-suites/acme.set/versions/1.0.0/unregister"),
    ] * 2


def test_conversations_list_takes_replays() -> None:
    # A comparison's replay conversations are left out unless asked for.
    api, seen = client(lambda r: httpx.Response(200, json={"data": [], "hasMore": False}))
    api.conversations.list()
    api.conversations.list(replays="only")
    assert dict(seen[0].url.params) == {}
    assert dict(seen[1].url.params) == {"replays": "only"}


def test_a_list_query_parameter_repeats_its_key_in_order() -> None:
    project = "0b9f4c1e-1111-4a2b-8c3d-000000000001"
    api, seen = client(
        lambda _r: httpx.Response(
            200, json={"agentId": "acme.drafter", "version": "1.1.0", "via": "latest"}
        )
    )
    resolved = api.agents.live.resolve(
        "acme.drafter", project_id=project, segment=["company:acme", "role:counsel"]
    )
    assert resolved.via == "latest"
    assert seen[0].url.params.get_list("segment") == ["company:acme", "role:counsel"]
    assert seen[0].url.params["projectId"] == project


@pytest.mark.parametrize(
    ("response", "kind", "check"),
    [
        (
            error(404, "run-not-found", details={"runId": "r-9"}),
            NotFoundError,
            lambda e: (e.kind, e.id) == ("run", "r-9"),
        ),
        (
            error(409, "run-already-terminal"),
            ConflictError,
            lambda e: e.server_code == "run-already-terminal",
        ),
        (
            error(409, "slug-conflict", details={"resource": "project", "slug": "acme"}),
            ConflictError,
            lambda e: (e.server_code, e.details["slug"]) == ("slug-conflict", "acme"),
        ),
        (
            error(409, "project-default-already-exists"),
            ConflictError,
            lambda e: e.server_code == "project-default-already-exists",
        ),
        (
            error(409, "registry-read-only"),
            ConflictError,
            lambda e: e.server_code == "registry-read-only",
        ),
        (
            error(409, "nothing-to-roll-back"),
            ConflictError,
            lambda e: e.server_code == "nothing-to-roll-back",
        ),
        (
            error(404, "agent-version-not-found"),
            NotFoundError,
            lambda e: e.kind == "agent-version",
        ),
        (
            error(400, "scope-invalid"),
            InvalidRequestError,
            lambda e: e.issues == [],
        ),
        (
            error(400, "validation-failed", details={"issues": [{"path": "/x", "message": "bad"}]}),
            InvalidRequestError,
            lambda e: e.issues == [{"path": "/x", "message": "bad"}],
        ),
        (
            error(
                422,
                "guardrail-violation",
                details={"violations": [{"guardrailId": "g"}], "evaluationErrors": []},
            ),
            GuardrailViolationError,
            lambda e: e.violations == [{"guardrailId": "g"}],
        ),
        (error(401, "auth-missing"), AuthError, lambda e: e.reason == "unauthenticated"),
        (error(403, "permission-denied"), AuthError, lambda e: e.reason == "forbidden"),
        (
            error(500, "kaboom", requestId="req-1"),
            ServerError,
            lambda e: (e.server_code, e.request_id, e.status) == ("kaboom", "req-1", 500),
        ),
        (httpx.Response(502, text="<html>"), ServerError, lambda e: e.server_code == "unknown"),
    ],
)
def test_errors_are_typed(
    response: httpx.Response, kind: type[Exception], check: Callable[[Any], bool]
) -> None:
    api, _ = client(lambda r: response, max_retries=0)
    with pytest.raises(kind) as raised:
        api.runs.get("r-9")
    assert check(raised.value)


def test_a_safe_call_is_retried_with_the_same_idempotency_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("kindgi.client._base.time.sleep", lambda s: None)
    answers = iter(
        [httpx.Response(503, headers={"retry-after": "0"}), httpx.Response(201, json=RUN)]
    )
    api, seen = client(lambda r: next(answers))
    api.runs.start(flow="f", input={})
    assert len(seen) == 2
    assert seen[0].headers["idempotency-key"] == seen[1].headers["idempotency-key"]


def test_rate_limits_exhaust_retries_then_raise(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("kindgi.client._base.time.sleep", lambda s: None)
    api, seen = client(lambda r: error(429, "rate-limited", retryAfterSeconds=7), max_retries=2)
    with pytest.raises(RateLimitedError) as raised:
        api.runs.get("r")
    assert raised.value.retry_after_seconds == 7 and len(seen) == 3


def test_a_post_without_an_idempotency_key_is_not_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("kindgi.client._base.time.sleep", lambda s: None)
    api, seen = client(lambda r: httpx.Response(503))
    with pytest.raises(ServerError):
        api.eval_runs.cancel("run-1")
    assert len(seen) == 1 and "idempotency-key" not in seen[0].headers


def test_a_connection_error_is_a_network_error() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    api, seen = client(refuse, max_retries=0)
    with pytest.raises(NetworkError, match="ConnectError"):
        api.runs.get("r")
    assert len(seen) == 1


def sse(*events: dict[str, Any]) -> bytes:
    return "".join(
        f": comment\nid: {e['eventId']}\nevent: run\ndata: {json.dumps(e)}\n\n" for e in events
    ).encode()


class Dropping(httpx.SyncByteStream):
    """Delivers `body`, then the connection drops."""

    def __init__(self, body: bytes) -> None:
        self.body = body

    def __iter__(self) -> Iterator[bytes]:
        yield self.body
        raise httpx.ReadError("connection reset")


def test_a_stream_resumes_after_a_drop_with_last_event_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("kindgi.client._base.time.sleep", lambda s: None)

    def handler(request: httpx.Request) -> httpx.Response:
        if "last-event-id" not in request.headers:
            return httpx.Response(200, stream=Dropping(sse(event(1), event(2))))
        assert request.headers["last-event-id"] == "e2"
        return httpx.Response(
            200, content=sse(event(3)), headers={"content-type": "text/event-stream"}
        )

    api, seen = client(handler)
    received = list(api.runs.stream(RUN["id"]))
    assert [e.sequence for e in received] == [1, 2, 3]
    assert all(isinstance(e, models.RunEvent) for e in received)
    assert seen[0].headers["accept"] == "text/event-stream"


def test_paginate_follows_the_cursor() -> None:
    item = {
        k: RUN[k]
        for k in (
            "id",
            "tenantId",
            "flowId",
            "flowVersion",
            "status",
            "dryRun",
            "createdAt",
            "updatedAt",
        )
    }
    pages = {
        None: {"data": [item, item], "hasMore": True, "nextCursor": "c2"},
        "c2": {"data": [item], "hasMore": False},
    }
    api, seen = client(lambda r: httpx.Response(200, json=pages[r.url.params.get("cursor")]))
    assert len(list(paginate(api.runs.list, limit=2))) == 3
    assert [r.url.params.get("cursor") for r in seen] == [None, "c2"]


@pytest.mark.parametrize("has_more", [True, None], ids=["hasMore", "older server"])
def test_paginate_pages_env_with_or_without_has_more(has_more: bool | None) -> None:
    entry = {
        "scope": {"kind": "tenant", "tenantId": "acme"},
        "envName": "dev",
        "name": "REGION",
        "value": "eu",
        "revision": 1,
        "createdAt": "2026-10-01T00:00:00Z",
        "updatedAt": "2026-10-01T00:00:00Z",
    }
    first: dict[str, Any] = {"data": [entry], "nextCursor": "c2"}
    last: dict[str, Any] = {"data": [entry]}
    if has_more is not None:
        first["hasMore"], last["hasMore"] = True, False
    pages = {None: first, "c2": last}
    api, seen = client(lambda r: httpx.Response(200, json=pages[r.url.params.get("cursor")]))
    entries = list(paginate(api.env.list, env_name="dev", scope_kind="tenant"))
    assert len(entries) == 2
    assert [r.url.params.get("cursor") for r in seen] == [None, "c2"]


def test_settings_come_from_the_environment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.chdir(tmp_path)  # no running kindgi dev to fall back to
    monkeypatch.setenv("KINDGI_API_URL", "http://env.test")
    monkeypatch.setenv("KINDGI_API_TOKEN", "kgi_bt_env")
    with Kindgi() as api:
        assert (api.base_url, api.token) == ("http://env.test", "kgi_bt_env")
    monkeypatch.delenv("KINDGI_API_TOKEN")
    with pytest.raises(ValueError, match="KINDGI_API_TOKEN"):
        Kindgi()


def test_the_async_client() -> None:
    async def scenario() -> None:
        page = {"data": [], "hasMore": False}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/stream"):
                return httpx.Response(200, content=sse(event(1), event(2)))
            return httpx.Response(200, json=page if request.url.path == "/v1/runs" else RUN)

        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        async with AsyncKindgi("http://kindgi.test", token="t", http_client=http) as api:
            run = await api.runs.get(RUN["id"])
            assert run.flow_id == "live.shout-flow"
            assert [e.sequence async for e in api.runs.stream(RUN["id"])] == [1, 2]
            assert [r async for r in apaginate(api.runs.list)] == []

    asyncio.run(scenario())


def test_every_operation_is_a_method() -> None:
    from kindgi.client._resources import OPERATIONS

    api, _ = client(lambda r: httpx.Response(200))
    missing = []
    for op_id in OPERATIONS:
        node: Any = api
        *path, name = op_id.split(".")
        for segment in path:
            node = getattr(node, "".join("_" + c.lower() if c.isupper() else c for c in segment))
        snake = "".join("_" + c.lower() if c.isupper() else c for c in name)
        if not callable(getattr(node, snake, None)):
            missing.append(op_id)
    assert missing == []
    assert len(OPERATIONS) > 150


OPENAPI = Path(__file__).resolve().parents[3] / "packages" / "api" / "openapi.json"


@pytest.mark.skipif(not OPENAPI.is_file(), reason="not inside the kindgi-sdk repository")
def test_the_generated_client_is_in_step_with_openapi() -> None:
    script = Path(__file__).resolve().parents[1] / "scripts" / "gen_client.py"
    result = subprocess.run(
        [sys.executable, str(script), "--check"], capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr


def test_retention_scheduled_and_sweep() -> None:
    """T236: the retention routes, with the conflicts a page reports."""
    conflict = {
        "domain": "provider",
        "policyIds": ["acme.keep-providers", "acme.keep-providers-long"],
        "appliedPolicyId": "acme.keep-providers",
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/retention/scheduled":
            return httpx.Response(
                200,
                json={
                    "data": [],
                    "domainsMissingAdapter": [],
                    "unpolicedDomains": ["run"],
                    "conflicts": [conflict],
                },
            )
        return httpx.Response(200, json={"perDomain": [], "totalPurged": 0})

    api, seen = client(handler)
    page = api.retention.scheduled(domain="provider", past_grace_only=True, limit=10)
    assert page.conflicts is not None
    assert page.conflicts[0].applied_policy_id == "acme.keep-providers"
    assert dict(seen[0].url.params) == {
        "domain": "provider",
        "pastGraceOnly": "true",
        "limit": "10",
    }

    api.retention.sweep(max_per_domain=100)
    assert (seen[1].method, seen[1].url.path) == ("POST", "/v1/retention/sweep")
    assert json.loads(seen[1].content) == {"maxPerDomain": 100}

    api.retention.sweep_domain("judge_class")
    assert seen[2].url.path == "/v1/retention/sweep/judge_class"


def test_a_second_retention_policy_for_a_domain_is_a_conflict() -> None:
    """T236: `409 policy-scope-taken` names the policy that covers the domain."""
    response = error(409, "policy-scope-taken", details={"heldBy": "acme.keep-providers"})
    api, _ = client(lambda r: response, max_retries=0)
    with pytest.raises(ConflictError) as raised:
        api.policies.publish(
            id="acme.keep-providers-long",
            version="1.0.0",
            kind="retention",
            spec={"v": 1, "doc": {"domain": "provider", "graceSeconds": 0, "mode": "purge"}},
        )
    assert raised.value.server_code == "policy-scope-taken"
    assert raised.value.details["heldBy"] == "acme.keep-providers"
