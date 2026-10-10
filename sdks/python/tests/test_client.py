# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`kindgi.client` against a mock transport: requests, answers, errors, retries, streams."""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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


def test_a_field_set_to_none_is_sent_as_null() -> None:
    # `assertable_by=None` lifts a judge class's restriction; a field left out stays out.
    judge_class = {
        "id": "jc-1",
        "tenantId": "t-1",
        "scope": {"kind": "tenant"},
        "name": "expert",
        "weight": 3,
        "createdAt": "2026-10-06T00:00:00.000Z",
        "updatedAt": "2026-10-06T00:00:00.000Z",
    }
    api, seen = client(lambda r: httpx.Response(200, json=judge_class))
    api.judge_classes.update("jc-1", assertable_by=None)
    api.judge_classes.update("jc-1", weight=2)
    assert [json.loads(r.content) for r in seen] == [{"assertableBy": None}, {"weight": 2}]


def test_approvals_list_takes_wait_token_ids() -> None:
    # The approvals a run's open waits belong to: `waitTokenId` repeated, in order.
    api, seen = client(lambda r: httpx.Response(200, json={"data": [], "hasMore": False}))
    api.approvals.list(wait_token_id=["tok-a", "tok-b"])
    assert seen[0].url.params.get_list("waitTokenId") == ["tok-a", "tok-b"]


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


def test_a_segment_path_is_its_steps_written_in_order() -> None:
    # `{key, value}` steps, as TypeScript and `runs.start` take them; each a
    # model or a mapping, written as repeated `segment=key:value`.
    project = "0b9f4c1e-1111-4a2b-8c3d-000000000001"
    api, seen = client(
        lambda r: httpx.Response(
            200,
            json={"agentId": "acme.drafter", "version": "1.1.0", "via": "latest"}
            if r.url.path.endswith("/live")
            else {"data": [], "hasMore": False},
        )
    )
    resolved = api.agents.live.resolve(
        "acme.drafter",
        project_id=project,
        segments=[
            {"key": "company", "value": "acme"},
            models.ScopeSegment(key="role", value="counsel"),
        ],
    )
    assert resolved.via == "latest"
    assert seen[0].url.params.get_list("segment") == ["company:acme", "role:counsel"]
    assert seen[0].url.params["projectId"] == project
    api.agents.promotions.list(
        "acme.drafter",
        scope_kind="segment",
        scope_id=project,
        segments=[{"key": "company", "value": "acme"}],
    )
    assert seen[1].url.params.get_list("segment") == ["company:acme"]
    api.agents.live.resolve("acme.drafter", project_id=project)
    assert "segment" not in seen[2].url.params


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
            error(409, "agent-version-live"),
            ConflictError,
            lambda e: e.server_code == "agent-version-live",
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


WAITED_START_TIMEOUT = (
    "The run didn't end within {} s, the client's timeout (timeout). "
    "A waited start answers only when the run ends, so the run may still be going, "
    "and its id didn't arrive. Start a run that can take longer with "
    '`options={{"wait": False}}`: the answer carries its id at once. Then follow it '
    "with `runs.stream(run_id)` or `runs.get(run_id)`. Or raise `timeout`."
)


def read_timeout(request: httpx.Request) -> httpx.Response:
    raise httpx.ReadTimeout("timed out", request=request)


def test_a_waited_start_is_not_sent_again_after_a_read_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # It may be running on the server, and its key isn't held while it runs:
    # a repeat would start the run again.
    monkeypatch.setattr("kindgi.client._base.time.sleep", lambda s: None)
    api, seen = client(read_timeout)
    with pytest.raises(NetworkError) as raised:
        api.runs.start(flow="f", input={})
    assert len(seen) == 1
    assert str(raised.value) == WAITED_START_TIMEOUT.format(60)
    assert raised.value.timeout == 60.0


def test_a_waited_start_names_the_calls_own_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("kindgi.client._base.time.sleep", lambda s: None)
    api, seen = client(read_timeout)
    with pytest.raises(NetworkError) as raised:
        api.runs.start(flow="f", input={}, timeout=2.5)
    assert len(seen) == 1
    assert str(raised.value) == WAITED_START_TIMEOUT.format(2.5)
    assert raised.value.timeout == 2.5


def test_a_start_without_waiting_gets_the_plain_timeout_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("kindgi.client._base.time.sleep", lambda s: None)
    api, seen = client(read_timeout)
    with pytest.raises(NetworkError) as raised:
        api.runs.start(flow="f", input={}, options={"wait": False})
    assert len(seen) == 1
    assert str(raised.value) == "runs.start: no answer within 60 s, the client's timeout (timeout)."


def test_a_get_is_still_retried_after_a_read_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("kindgi.client._base.time.sleep", lambda s: None)
    api, seen = client(read_timeout)
    with pytest.raises(NetworkError) as raised:
        api.runs.get("r")
    assert len(seen) == 3
    assert str(raised.value) == "runs.get: no answer within 60 s, the client's timeout (timeout)."


def test_a_post_is_retried_when_it_never_reached_the_server(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("kindgi.client._base.time.sleep", lambda s: None)
    answers: Iterator[Callable[[httpx.Request], httpx.Response]] = iter(
        [
            lambda r: (_ for _ in ()).throw(httpx.ConnectError("refused", request=r)),
            lambda r: (_ for _ in ()).throw(httpx.ConnectTimeout("no connect", request=r)),
            lambda r: httpx.Response(201, json=RUN),
        ]
    )
    api, seen = client(lambda r: next(answers)(r))
    api.runs.start(flow="f", input={})
    assert len(seen) == 3
    assert len({r.headers["idempotency-key"] for r in seen}) == 1


@pytest.mark.parametrize(
    "fail",
    [
        lambda r: (_ for _ in ()).throw(httpx.RemoteProtocolError("dropped", request=r)),
        lambda r: httpx.Response(504),
        lambda r: httpx.Response(502),
    ],
    ids=["a dropped connection", "a proxy's 504", "a proxy's 502"],
)
def test_a_post_is_not_sent_again_once_it_may_be_running(
    monkeypatch: pytest.MonkeyPatch, fail: Callable[[httpx.Request], httpx.Response]
) -> None:
    monkeypatch.setattr("kindgi.client._base.time.sleep", lambda s: None)
    api, seen = client(fail)
    with pytest.raises((NetworkError, ServerError)):
        api.runs.start(flow="f", input={})
    assert len(seen) == 1


def test_async_a_waited_start_is_not_sent_again_after_a_read_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def no_sleep(seconds: float) -> None:
        return None

    monkeypatch.setattr("kindgi.client._base.asyncio.sleep", no_sleep)
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        raise httpx.ReadTimeout("timed out", request=request)

    async def scenario() -> None:
        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        async with AsyncKindgi("http://kindgi.test", token="t", http_client=http) as api:
            with pytest.raises(NetworkError) as raised:
                await api.runs.start(flow="f", input={})
            assert str(raised.value) == WAITED_START_TIMEOUT.format(60)

    asyncio.run(scenario())
    assert len(seen) == 1


def test_a_server_slower_than_the_timeout_gets_one_start_not_three() -> None:
    """A real server that answers after the client's timeout: one run start reaches it."""
    starts: list[str] = []

    class Slow(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            self.rfile.read(int(self.headers["content-length"]))
            starts.append(self.headers["idempotency-key"])
            time.sleep(0.6)
            try:
                payload = json.dumps(RUN).encode()
                self.send_response(201)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass  # the client stopped waiting

        def log_message(self, format: str, *args: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Slow)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    api = Kindgi(f"http://127.0.0.1:{server.server_port}", token="kgi_bt_test", timeout=0.2)
    try:
        with pytest.raises(NetworkError) as raised:
            api.runs.start(flow="acme.slow", input={})
        # Any retry would have been sent before the error was raised.
        assert len(starts) == 1
        assert str(raised.value) == WAITED_START_TIMEOUT.format(0.2)
    finally:
        api.close()
        server.shutdown()
        server.server_close()


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


def test_settings_are_found_on_first_use_not_when_the_client_is_created(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # A module-scope `Kindgi()` must load in a build step that imports the app
    # without its settings (Django's `collectstatic`, a Docker build).
    monkeypatch.chdir(tmp_path)  # no running kindgi dev to fall back to
    monkeypatch.delenv("KINDGI_API_URL", raising=False)
    monkeypatch.delenv("KINDGI_API_TOKEN", raising=False)
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"data": [], "hasMore": False})

    api = Kindgi(http_client=httpx.Client(transport=httpx.MockTransport(record)))
    # The first use says what to set, and nothing is sent.
    with pytest.raises(ValueError, match="KINDGI_API_URL and KINDGI_API_TOKEN"):
        api.runs.list()
    with pytest.raises(ValueError, match="KINDGI_API_URL"):
        _ = api.base_url
    assert seen == []
    # Once they're set, the next use finds them, and keeps them.
    monkeypatch.setenv("KINDGI_API_URL", "http://env.test/")
    monkeypatch.setenv("KINDGI_API_TOKEN", "kgi_bt_env")
    api.runs.list()
    assert str(seen[0].url).startswith("http://env.test/v1/runs")
    assert seen[0].headers["authorization"] == "Bearer kgi_bt_env"
    monkeypatch.setenv("KINDGI_API_TOKEN", "kgi_bt_other")
    api.runs.list()
    assert seen[1].headers["authorization"] == "Bearer kgi_bt_env"
    api.close()


def test_the_async_client_finds_its_settings_on_first_use_too(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("KINDGI_API_URL", raising=False)
    monkeypatch.delenv("KINDGI_API_TOKEN", raising=False)

    async def scenario() -> None:
        seen: list[httpx.Request] = []

        def record(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json={"data": [], "hasMore": False})

        async with AsyncKindgi(
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(record))
        ) as api:
            with pytest.raises(ValueError, match="KINDGI_API_TOKEN"):
                await api.runs.list()
            assert seen == []
            monkeypatch.setenv("KINDGI_API_URL", "http://env.test")
            monkeypatch.setenv("KINDGI_API_TOKEN", "kgi_bt_env")
            await api.runs.list()
            assert seen[0].headers["authorization"] == "Bearer kgi_bt_env"

    asyncio.run(scenario())


def test_default_headers_still_come_after_the_clients_own(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    api, seen = client(
        lambda r: httpx.Response(200, json={"data": [], "hasMore": False}),
        default_headers={"User-Agent": "acme-app/1.0", "X-Acme": "yes"},
    )
    api.runs.list()
    assert seen[0].headers["user-agent"] == "acme-app/1.0"
    assert seen[0].headers["x-acme"] == "yes"
    assert seen[0].headers["authorization"] == "Bearer kgi_bt_test"


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


def test_an_artifact_belongs_to_a_project_and_a_feature_names_its_providers() -> None:
    meta = {
        "blobId": "b-1",
        "tenantId": RUN["tenantId"],
        "name": "note.txt",
        "contentType": "text/plain",
        "size": 5,
        "hash": "0" * 64,
        "tags": {},
        "projectId": "p-1",
        "createdBy": "user:u-1",
        "createdAt": "2026-10-07T00:00:00.000Z",
    }
    capability = {
        "id": "feature:vision",
        "feature": "vision",
        "description": "Reads images in its input.",
        "providers": [{"providerId": "acme-openai", "models": ["gpt-acme"]}],
    }
    api, seen = client(
        lambda r: (
            httpx.Response(201, json=meta)
            if r.url.path == "/v1/artifacts"
            else httpx.Response(200, json=capability)
        )
    )
    up = api.artifacts.upload(
        {"file": ("note.txt", b"hello", "text/plain")}, data={"projectId": "p-1"}
    )
    assert (
        isinstance(up, models.BlobMeta) and up.project_id == "p-1" and up.created_by == "user:u-1"
    )
    assert b'name="projectId"' in seen[0].content and b"hello" in seen[0].content
    vision = api.capabilities.get("feature:vision")
    assert vision.providers is not None
    assert isinstance(vision.providers[0], models.CapabilityProvider)
    assert vision.providers[0].models == ["gpt-acme"]


def test_every_model_a_method_names_exists() -> None:
    # The generator inlines a union used only inside other models; a body
    # naming it would then fail at call time.
    import re

    from kindgi.client import _models

    source = (Path(__file__).resolve().parents[1] / "src/kindgi/client/_resources.py").read_text()
    named = set(re.findall(r"_models\.([A-Za-z0-9_]+)", source))
    assert sorted(n for n in named if not hasattr(_models, n)) == []


def test_create_erasure_sends_exactly_one_selector() -> None:
    created = {
        "id": "6ccd0eca-40b4-4b86-b8f5-24b0900ddd02",
        "selectorKind": "participant",
        "status": "pending",
        "phase": "seed",
        "requestedBy": "user:u-1",
        "matchable": True,
        "counts": {},
        "attempts": 0,
        "createdAt": "2026-10-08T00:00:00.000Z",
    }
    api, seen = client(lambda r: httpx.Response(202, json=created))
    out = api.memory.create_erasure(subject={"kind": "participant", "id": "p-1"})
    assert isinstance(out, models.MemoryErasureCreated) and out.selector_kind == "participant"
    api.memory.create_erasure({"conversationId": "c-1"}, idempotency_key="k-1")
    api.memory.create_erasure(models.MemoryErasureFactSelector(fact_id="f-1"))
    assert [json.loads(r.content) for r in seen] == [
        {"subject": {"kind": "participant", "id": "p-1"}},
        {"conversationId": "c-1"},
        {"factId": "f-1"},
    ]
    assert seen[1].headers["Idempotency-Key"] == "k-1"


def test_api_keys_for_a_principal_and_service_accounts() -> None:
    minted = {
        "tokenId": "6ccd0eca-40b4-4b86-b8f5-24b0900ddd01",
        "token": "kgi_ak_secret",
        "principal": {"kind": "service-account", "id": "sa-1"},
        "role": "member",
        "capabilities": [],
        "createdAt": "2026-10-07T00:00:00.000Z",
    }
    account = {
        "serviceAccountId": "sa-1",
        "name": "acme-ci",
        "grants": [{"kind": "tenant-admin"}],
        "createdAt": "2026-10-07T00:00:00.000Z",
    }
    api, seen = client(
        lambda r: (
            httpx.Response(201, json=minted)
            if r.url.path == "/v1/tokens"
            else httpx.Response(200, json=account)
        )
    )
    key = api.tokens.mint(for_={"kind": "service-account", "id": "sa-1"})
    assert key.principal is not None and key.principal.id == "sa-1"
    granted = api.service_accounts.grant("sa-1", {"kind": "tenant-admin"})
    assert isinstance(granted, models.ServiceAccount) and granted.name == "acme-ci"
    api.service_accounts.ungrant("sa-1", kind="project", project_id=RUN["tenantId"])
    assert [(r.method, r.url.path, json.loads(r.content)) for r in seen] == [
        ("POST", "/v1/tokens", {"for": {"kind": "service-account", "id": "sa-1"}}),
        ("POST", "/v1/service-accounts/sa-1/grant", {"kind": "tenant-admin"}),
        (
            "POST",
            "/v1/service-accounts/sa-1/ungrant",
            {"kind": "project", "projectId": RUN["tenantId"]},
        ),
    ]


def test_a_persons_grants_and_tenant_admin() -> None:
    grants = {
        "userId": "u-1",
        "tenantAdmin": True,
        "projects": [{"projectId": "p-1", "role": "editor"}],
        "teams": [{"teamId": "t-1", "role": "member"}],
        "reviewer": {"role": "senior"},
    }
    api, seen = client(lambda r: httpx.Response(200, json=grants))
    read = api.identity.users.grants("u-1")
    assert isinstance(read, models.PersonGrants) and read.tenant_admin is True
    assert isinstance(read.projects[0], models.PersonProjectRole)
    assert isinstance(read.teams[0], models.PersonTeamRole)
    assert read.reviewer is not None and read.reviewer.role == "senior"
    api.identity.users.grant("u-1", kind="tenant-admin")
    api.identity.users.ungrant("u-1", kind="tenant-admin")
    assert [(r.method, r.url.path) for r in seen] == [
        ("GET", "/v1/identity/users/u-1/grants"),
        ("POST", "/v1/identity/users/u-1/grant"),
        ("POST", "/v1/identity/users/u-1/ungrant"),
    ]
    assert json.loads(seen[1].content) == {"kind": "tenant-admin"}


def test_named_models_keep_their_names() -> None:
    # Inline shapes in a new schema once renamed `Team`/`Project` to `Team1`/`Project1`;
    # a `$ref` to `RunStatus` beside its inline uses folds the `RunStatus` class away.
    for name in (
        "Team",
        "Project",
        "Reviewer",
        "PersonGrants",
        "ServiceAccountGrantBody",
        "RunStatus",
    ):
        assert hasattr(models, name), name
    for name in ("Team1", "Project1", "Reviewer1"):
        assert not hasattr(models, name), name


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


def test_retention_scheduled_pages_with_a_cursor() -> None:
    """T249: `cursor` goes in the query; `has_more` and `next_cursor` come back."""

    def item(n: int) -> dict[str, Any]:
        return {
            "domain": "agent",
            "id": f"agent-{n}",
            "unregisteredAt": "2026-10-01T00:00:00Z",
            "purgeAt": "2026-10-02T00:00:00Z",
            "pastGrace": True,
            "policyId": "acme.keep-agents",
            "policyVersion": "1.0.0",
            "graceSeconds": 86_400,
        }

    def handler(request: httpx.Request) -> httpx.Response:
        first = "cursor" not in request.url.params
        return httpx.Response(
            200,
            json={
                "data": [item(1)] if first else [item(2)],
                "domainsMissingAdapter": [],
                "unpolicedDomains": [],
                "hasMore": first,
                **({"nextCursor": "c-2"} if first else {}),
            },
        )

    api, seen = client(handler)
    page = api.retention.scheduled(limit=1)
    assert (page.has_more, page.next_cursor) == (True, "c-2")
    assert [row.id for row in paginate(api.retention.scheduled, limit=1)] == ["agent-1", "agent-2"]
    assert dict(seen[-1].url.params) == {"limit": "1", "cursor": "c-2"}


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


def test_observations_list_sends_every_filter_the_route_reads() -> None:
    """`agentVersion`, `conversationId`, `since` and `until` were missing from the spec."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [], "hasMore": False})

    api, seen = client(handler)
    api.observations.list(
        agent_id="acme.helper",
        agent_version="1.0.0",
        conversation_id="c-1",
        since="2026-10-01T00:00:00Z",
        until="2026-10-06T00:00:00Z",
    )
    assert dict(seen[0].url.params) == {
        "agentId": "acme.helper",
        "agentVersion": "1.0.0",
        "conversationId": "c-1",
        "since": "2026-10-01T00:00:00Z",
        "until": "2026-10-06T00:00:00Z",
    }


def test_a_model_s_uuid_id_passes_back_as_text_in_a_path_and_a_query() -> None:
    """T309: ids the models carry as `UUID` go straight back into the client."""
    run_id = uuid.UUID("0b6e3c1e-2f4f-4a51-9d0e-7a1f2c3d4e5f")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/v1/approvals"):
            return httpx.Response(200, json={"data": [], "hasMore": False})
        return httpx.Response(404, json={"error": {"code": "run-not-found", "message": "no"}})

    api, seen = client(handler)
    with pytest.raises(NotFoundError):
        api.runs.get(run_id)
    api.approvals.list(wait_token_id=[run_id, "wt-2"])
    assert seen[0].url.path == f"/v1/runs/{run_id}"
    assert seen[1].url.params.get_list("waitTokenId") == [str(run_id), "wt-2"]
