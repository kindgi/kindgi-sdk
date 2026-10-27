# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A tool that declares `stores_files=True` gets `ctx.files` when the call carries a file upload:
each store posts the bytes to the upload link, and the handler never sees the link or its token
(pack protocol 2.10.0)."""

from __future__ import annotations

import json
import re
import threading
from collections.abc import AsyncIterator, Callable, Iterator, Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import httpx
import pytest
from pydantic import BaseModel

from kindgi import (
    MAX_STORED_FILE_BYTES,
    MAX_STORED_FILES_PER_CALL,
    FileStore,
    FileStoreAnswer,
    FileStoreError,
    ToolContext,
    tool,
)
from kindgi.pack.context import Cancellation
from kindgi.pack.files import file_store_from_wire
from kindgi.pack.index import run_indexer
from kindgi.pack.service import PackService

TOKEN = "kgi_fu_test-token"
TOOLS_FILES = Path(__file__).resolve().parents[3] / "packages" / "tools" / "src" / "files.ts"

STORED = {
    "type": "kindgi.file",
    "artifactId": "art-1",
    "name": "invoice.pdf",
    "contentType": "application/pdf",
    "size": 4,
    "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
}


class Link:
    """The upload link: answers `answer`, and keeps what it received."""

    def __init__(self) -> None:
        self.answer: tuple[int, Any] = (200, {"file": STORED})
        self.received: list[dict[str, Any]] = []
        link = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("content-length", "0"))
                link.received.append(
                    {
                        "path": self.path,
                        "headers": {k.lower(): v for k, v in self.headers.items()},
                        "body": self.rfile.read(length),
                    }
                )
                status, body = link.answer
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args: Any) -> None:
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}/v1/file-uploads"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


@pytest.fixture
def link() -> Iterator[Link]:
    served = Link()
    yield served
    served.close()


def _store(link: Link) -> FileStore:
    store = file_store_from_wire({"fileUpload": {"url": link.url, "token": TOKEN}})
    assert store is not None
    return store


def test_a_tool_that_stores_files_gets_a_store_and_never_the_token(link: Link) -> None:
    wire = {"tenantId": "t", "runId": "r", "fileUpload": {"url": link.url, "token": TOKEN}}
    ctx = ToolContext.from_wire(wire, Cancellation(), stores_files=True)
    assert isinstance(ctx.files, FileStore)
    assert TOKEN not in repr(ctx)
    assert TOKEN not in repr(ctx.files)
    assert ToolContext.from_wire(wire, Cancellation()).files is None


@pytest.mark.parametrize(
    "upload",
    [
        None,
        "kgi_fu_x",
        {"url": "ftp://kindgi.example/x", "token": TOKEN},
        {"url": "https://", "token": TOKEN},
        {"url": "https://kindgi.example/v1/file-uploads"},
        {"url": "https://kindgi.example/v1/file-uploads", "token": ""},
        {"url": "https://kindgi.example/v1/file-uploads", "token": "kgi_fu_a\r\nb"},
        {"url": "https://kindgi.example/v1/file-uploads", "token": "kgi_fu_é"},
    ],
)
def test_no_upload_or_an_unusable_one_is_no_store(upload: Any) -> None:
    wire = {"tenantId": "t", "runId": "r", **({} if upload is None else {"fileUpload": upload})}
    assert ToolContext.from_wire(wire, Cancellation(), stores_files=True).files is None


def test_a_store_posts_the_bytes_with_the_token_and_answers_the_file(link: Link) -> None:
    answer = _store(link).store(name="invoice.pdf", content_type="application/pdf", data=b"test")
    assert answer == FileStoreAnswer(file=STORED)
    [received] = link.received
    assert received["path"] == "/v1/file-uploads"
    assert received["headers"]["authorization"] == f"Bearer {TOKEN}"
    assert received["headers"]["content-type"] == "application/pdf"
    assert received["headers"]["kindgi-file-name"] == "invoice.pdf"
    assert received["body"] == b"test"


@pytest.mark.anyio
async def test_an_async_handler_stores_the_same_way(link: Link) -> None:
    answer = await _store(link).store_async(
        name="invoice.pdf", content_type="application/pdf", data=b"test"
    )
    assert answer == FileStoreAnswer(file=STORED)
    assert link.received[0]["body"] == b"test"


def test_the_name_is_percent_encoded_and_a_type_a_header_cant_carry_is_octet_stream(
    link: Link,
) -> None:
    store = _store(link)
    store.store(name="Rechnung März\r\n.pdf", content_type="application/pdf", data=b"test")
    for content_type in ("", "application/pdf\r\nx-acme: 1", "application/péf"):
        store.store(name="x", content_type=content_type, data=b"test")
    assert link.received[0]["headers"]["kindgi-file-name"] == "Rechnung%20M%C3%A4rz%0D%0A.pdf"
    assert [r["headers"]["content-type"] for r in link.received[1:]] == [
        "application/octet-stream"
    ] * 3


@pytest.mark.parametrize("reason", ["type", "size", "limit"])
def test_answers_why_nothing_was_stored(link: Link, reason: str) -> None:
    link.answer = (200, {"notStored": reason})
    answer = _store(link).store(name="x", content_type="text/plain", data=b"test")
    assert answer == FileStoreAnswer(not_stored=reason)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "body",
    [{"file": {**STORED, "sha256": "ABC"}}, {"notStored": "gone"}, {}, None],
)
def test_an_answer_that_isnt_a_file_or_a_reason_raises(link: Link, body: Any) -> None:
    link.answer = (200, body)
    with pytest.raises(FileStoreError, match="isn't a stored file or a reason"):
        _store(link).store(name="x", content_type="text/plain", data=b"test")


def test_a_refused_store_raises_naming_the_status_and_the_code(link: Link) -> None:
    link.answer = (409, {"error": {"code": "file-upload-closed", "message": "closed"}})
    with pytest.raises(FileStoreError, match=r"answered 409 \(file-upload-closed\)"):
        _store(link).store(name="x", content_type="text/plain", data=b"test")


def test_a_runtime_that_cant_be_reached_raises(link: Link) -> None:
    url = link.url
    link.close()
    store = file_store_from_wire({"fileUpload": {"url": url, "token": TOKEN}})
    assert store is not None
    with pytest.raises(FileStoreError, match="can't be reached") as raised:
        store.store(name="x", content_type="text/plain", data=b"test")
    assert TOKEN not in str(raised.value)


@pytest.mark.anyio
async def test_a_file_over_the_largest_any_type_allows_answers_size_and_nothing_is_sent(
    link: Link,
) -> None:
    over = bytes(MAX_STORED_FILE_BYTES + 1)
    store = _store(link)
    assert store.store(name="x.pdf", content_type="application/pdf", data=over) == FileStoreAnswer(
        not_stored="size"
    )
    answer = await store.store_async(name="x.pdf", content_type="application/pdf", data=over)
    assert answer == FileStoreAnswer(not_stored="size")
    assert link.received == []


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("MAX_STORED_FILES_PER_CALL", MAX_STORED_FILES_PER_CALL),
        ("MAX_STORED_FILE_BYTES", MAX_STORED_FILE_BYTES),
    ],
)
def test_the_limits_are_the_typescript_sdks(name: str, value: int) -> None:
    found = re.search(rf"export const {name} = ([0-9_]+);", TOOLS_FILES.read_text())
    assert found is not None
    assert int(found.group(1)) == value


@pytest.mark.parametrize(
    "kwargs",
    [
        {"name": None, "content_type": "text/plain", "data": b"x"},
        {"name": "x", "content_type": 7, "data": b"x"},
        {"name": "x", "content_type": "text/plain", "data": "x"},
    ],
)
def test_a_file_shaped_wrong_is_refused_before_its_sent(link: Link, kwargs: Any) -> None:
    with pytest.raises(TypeError):
        _store(link).store(**kwargs)
    assert link.received == []


class Fetch(BaseModel):
    attachment: str


PACK = """
from typing import Any
from pydantic import BaseModel
from kindgi import ToolContext, tool

class Fetch(BaseModel):
    attachment: str

@tool(id="acme.mail.attachment-get", stores_files=True, result_is_outside_data=True)
def attachment_get(input: Fetch, ctx: ToolContext) -> Any:
    "Fetches a mail's attachment."
    if ctx.files is None:
        return {"notShown": "store"}
    answer = ctx.files.store(name=input.attachment, content_type="application/pdf", data=b"test")
    return {"files": [answer.file]} if answer.file is not None else {"notShown": answer.not_stored}

@tool(id="acme.mail.message-get")
async def message_get(input: Fetch, ctx: ToolContext) -> Any:
    "Reads a mail; it stores nothing."
    return {"files": ctx.files is not None}
"""


def _index(root: Path) -> dict[str, Any]:
    outcome = run_indexer(root, artifact_version="1.1", published_at="2026-10-01T00:00:00.000Z")
    assert outcome["kind"] == "ok" and outcome["value"]["fileErrors"] == [], outcome
    return json.loads(Path(outcome["value"]["outputPath"]).read_text())


def test_the_index_says_which_tools_store_files(make_pack: Callable[..., Path]) -> None:
    @tool(id="acme.mail.attachment-get", stores_files=True)
    def attachment_get(input: Fetch) -> dict[str, Any]:
        "Fetches a mail's attachment."
        return {}

    assert attachment_get.stores_files
    entries = {t["id"]: t for t in _index(make_pack({"tools/mail.py": PACK}))["tools"]}
    assert entries["acme.mail.attachment-get"]["storesFiles"] is True
    assert "storesFiles" not in entries["acme.mail.message-get"]


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def client(make_pack: Callable[..., Path]) -> AsyncIterator[httpx.AsyncClient]:
    root = make_pack({"tools/mail.py": PACK})
    service = PackService(_index(root), root, "tok", logger=lambda _record: None)
    assert service.prewarm() == []
    transport = httpx.ASGITransport(app=service)
    async with httpx.AsyncClient(transport=transport, base_url="http://pack") as http:
        yield http
    service.close()


async def call(
    http: httpx.AsyncClient, tool_id: str, upload: Mapping[str, Any] | None
) -> dict[str, Any]:
    ctx = {"tenantId": "t", "runId": "r", **({} if upload is None else {"fileUpload": upload})}
    message = {
        "v": 2,
        "kind": "invoke",
        "tool": {"id": tool_id},
        "input": {"attachment": "invoice.pdf"},
        "ctx": ctx,
    }
    headers = {"kindgi-pack-token": "tok", "content-type": "application/json"}
    response = await http.post("/v1/invoke", json=message, headers=headers)
    assert response.status_code == 200
    return response.json()


@pytest.mark.anyio
async def test_the_service_gives_a_tool_that_stores_files_its_calls_store(
    client: httpx.AsyncClient, link: Link
) -> None:
    upload = {"url": link.url, "token": TOKEN}
    answered = await call(client, "acme.mail.attachment-get", upload)
    assert answered["kind"] == "result"
    assert answered["output"] == {"files": [STORED]}
    assert link.received[0]["headers"]["authorization"] == f"Bearer {TOKEN}"
    # A runtime before pack protocol 2.10.0 sends no upload.
    no_upload = await call(client, "acme.mail.attachment-get", None)
    assert no_upload["output"] == {"notShown": "store"}


@pytest.mark.anyio
async def test_the_service_gives_a_tool_that_doesnt_store_files_none(
    client: httpx.AsyncClient, link: Link
) -> None:
    answered = await call(client, "acme.mail.message-get", {"url": link.url, "token": TOKEN})
    assert answered["output"] == {"files": False}
    assert link.received == []


@pytest.mark.anyio
async def test_a_refused_store_fails_the_call_without_the_token(
    client: httpx.AsyncClient, link: Link
) -> None:
    link.answer = (409, {"error": {"code": "file-upload-closed", "message": "closed"}})
    answered = await call(client, "acme.mail.attachment-get", {"url": link.url, "token": TOKEN})
    assert answered["kind"] == "error"
    assert answered["code"] == "handler-throw"
    assert "file-upload-closed" in answered["message"]
    assert TOKEN not in json.dumps(answered)
