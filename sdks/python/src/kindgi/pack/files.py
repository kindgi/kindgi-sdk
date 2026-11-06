# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""Files a tool stores and reads (pack protocol 2.10.0).

A tool that declares `stores_files=True` gets `ctx.files.store` with each call: it
fetches a file (a mail's attachment, say) and stores it, and the runtime checks
the bytes, stores them as a file the call's run owns, and answers a file value.
The tool returns that value in its result's top-level `files`, and an agent is
shown the file. A tool that declares `reads_files=True` gets `ctx.files.read`: it
reads the bytes of a file its run may be shown, by the file value's `artifactId`.
The pack service sends and gets the bytes at the call's tool-files link; the
handler never sees the link or its token.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Final, Literal, cast
from urllib.parse import quote, urlsplit

import httpx

__all__ = [
    "MAX_STORED_FILES_PER_CALL",
    "MAX_STORED_FILE_BYTES",
    "FileReadAnswer",
    "FileStore",
    "FileStoreAnswer",
    "FileStoreError",
    "NotReadReason",
    "NotStoredReason",
    "file_store_from_wire",
]

MAX_STORED_FILES_PER_CALL: Final = 10
"""The most files one call may store: the call's later stores answer `limit`."""

MAX_STORED_FILE_BYTES: Final = 10_000_000
"""The most bytes a stored file may have: the largest any type allows (a PDF's 10 MB). A store
of more answers `size` without sending its bytes."""

NotStoredReason = Literal["type", "size", "limit", "storage"]
"""Why a store kept nothing: `type` (the bytes aren't a type a model is shown, or not the type
they claim), `size` (over the type's limit), `limit` (the call has stored
`MAX_STORED_FILES_PER_CALL` files), `storage` (the workspace's storage is full)."""

NotReadReason = Literal["rule", "gone", "changed", "size"]
"""Why a read answered no bytes: `rule` (the call's run may not be shown a file of that id),
`gone` (deleted, or its bytes are missing), `changed` (its bytes aren't the ones that were
checked), `size` (over its type's limit)."""

_NOT_STORED_REASONS: Final = frozenset(("type", "size", "limit", "storage"))
_NOT_READ_REASONS: Final = frozenset(("rule", "gone", "changed", "size"))
_FILE_NOT_SHOWN_REASONS: Final = frozenset(
    ("type", "size", "model", "limit", "store", "gone", "changed", "refused", "storage", "reading")
)
_SHA256_HEX: Final = re.compile(r"[0-9a-f]{64}")
_TIMEOUT: Final = httpx.Timeout(60.0, connect=10.0)


class FileStoreError(Exception):
    """Raised by `FileStore`'s methods when the runtime refuses the store or the read or can't
    be reached, or when the call has no such method (`stores`, `reads`).

    Let it propagate: the call fails as any exception fails it.
    """


@dataclass(frozen=True, slots=True)
class FileStoreAnswer:
    """What a store answers: `file`, the stored file's value, or `not_stored`, why nothing was.

    Return `file` in the result's top-level `files` (`{"files": [answer.file]}`), and an agent is
    shown the file. For `not_stored`, return the reason as the file's `notShown`, so the agent
    reads a line naming it.
    """

    file: Mapping[str, Any] | None = None
    """The stored file's value (`{"type": "kindgi.file", "artifactId": …}`), as JSON."""
    not_stored: NotStoredReason | None = None


@dataclass(frozen=True, slots=True)
class FileReadAnswer:
    """What a read answers: `data`, the file's bytes as it was stored, or `not_read`, why there
    are none."""

    data: bytes | None = field(default=None, repr=False)
    not_read: NotReadReason | None = None


@dataclass(frozen=True, slots=True)
class FileStore:
    """A call's files (`ToolContext.files`): `store` for a tool that declares
    `stores_files=True`, on a call with an idempotency key, and `read` for one that declares
    `reads_files=True`. `stores` and `reads` say which the call has; the other raises
    `FileStoreError`.

    Storing the same bytes again in the same call, a re-run of it included, answers the first
    file and stores nothing new. A call stores at most `MAX_STORED_FILES_PER_CALL` files.
    """

    _url: str = field(repr=False)
    _token: str = field(repr=False)
    stores: bool = False
    """Whether the call stores files: its tool declares `stores_files=True` and the call has
    an idempotency key."""
    reads: bool = False
    """Whether the call reads files: its tool declares `reads_files=True`."""

    def store(self, *, name: str, content_type: str, data: bytes) -> FileStoreAnswer:
        """Store one file, from a sync handler. `name` is its name as its source gives it (an
        empty one is stored as `unnamed`); `content_type` the type its source declares, which
        the runtime checks the bytes against. Raises `FileStoreError` when the runtime refuses
        the store or can't be reached."""
        request = self._request(name, content_type, data)
        if request is None:
            return FileStoreAnswer(not_stored="size")
        try:
            with httpx.Client(timeout=_TIMEOUT) as client:
                response = client.post(self._url, **request)
        except httpx.HTTPError as cause:
            raise FileStoreError(f"files.store: the runtime can't be reached: {cause}") from None
        return _store_answer_of(response)

    async def store_async(self, *, name: str, content_type: str, data: bytes) -> FileStoreAnswer:
        """`store`, from an async handler."""
        request = self._request(name, content_type, data)
        if request is None:
            return FileStoreAnswer(not_stored="size")
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                response = await client.post(self._url, **request)
        except httpx.HTTPError as cause:
            raise FileStoreError(f"files.store: the runtime can't be reached: {cause}") from None
        return _store_answer_of(response)

    def read(self, artifact_id: str) -> FileReadAnswer:
        """Read a stored file's bytes, from a sync handler, by its file value's `artifactId`: a
        file the call's run may be shown, such as one in the run's input, in its conversation,
        or one a tool stored in it. Answers the bytes it was stored with, never a copy made for
        a model, as `data`, or why there are none, as `not_read`. Raises `FileStoreError` when
        the runtime refuses the read or can't be reached."""
        url = self._read_url(artifact_id)
        try:
            with httpx.Client(timeout=_TIMEOUT) as client:
                response = client.get(url, headers={"authorization": f"Bearer {self._token}"})
        except httpx.HTTPError as cause:
            raise FileStoreError(f"files.read: the runtime can't be reached: {cause}") from None
        return _read_answer_of(response)

    async def read_async(self, artifact_id: str) -> FileReadAnswer:
        """`read`, from an async handler."""
        url = self._read_url(artifact_id)
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                response = await client.get(url, headers={"authorization": f"Bearer {self._token}"})
        except httpx.HTTPError as cause:
            raise FileStoreError(f"files.read: the runtime can't be reached: {cause}") from None
        return _read_answer_of(response)

    def _read_url(self, artifact_id: object) -> str:
        """The read's link: the file's id, percent-encoded, under the call's link. A lone
        surrogate in the id goes as U+FFFD, which names no file: the runtime answers `rule`."""
        if not self.reads:
            raise FileStoreError(
                "files.read: this call reads no files: its tool doesn't declare reads_files=True"
            )
        if not isinstance(artifact_id, str) or artifact_id == "":
            raise TypeError("files.read takes a file value's artifactId, a str")
        return f"{self._url.rstrip('/')}/{quote(_well_formed(artifact_id), safe='')}"

    def _request(self, name: object, content_type: object, data: object) -> dict[str, Any] | None:
        """The store's request, or None for bytes over `MAX_STORED_FILE_BYTES`: the runtime
        would answer `size`, so nothing is sent. Its arguments are checked as any values: a
        handler's types aren't checked when it runs."""
        if not self.stores:
            raise FileStoreError(
                "files.store: this call stores no files: its tool doesn't declare"
                " stores_files=True, or the call has no idempotency key"
            )
        if not isinstance(name, str) or not isinstance(content_type, str):
            raise TypeError("files.store takes name: str, content_type: str, data: bytes")
        # A memoryview's length counts its items, not its bytes.
        content = data.tobytes() if isinstance(data, memoryview) else data
        if not isinstance(content, (bytes, bytearray)):
            raise TypeError("files.store takes name: str, content_type: str, data: bytes")
        if len(content) > MAX_STORED_FILE_BYTES:
            return None
        return {
            "headers": {
                "authorization": f"Bearer {self._token}",
                "content-type": _sendable_type(content_type),
                "kindgi-file-name": quote(_well_formed(name), safe=""),
            },
            "content": bytes(content),
        }


def file_store_from_wire(ctx: Mapping[str, Any], *, stores: bool, reads: bool) -> FileStore | None:
    """A protocol v2 `ctx`'s `toolFiles` (protocol 2.10.0) as a call's files, with `store` as
    `stores` says and `read` as `reads` says, if it carries usable ones: an http(s) link and a
    token a header can carry. None when it may do neither."""
    if not stores and not reads:
        return None
    value = ctx.get("toolFiles")
    if not isinstance(value, Mapping):
        return None
    link = cast("Mapping[str, Any]", value)
    url, token = link.get("url"), link.get("token")
    if not isinstance(url, str) or not _is_http_url(url):
        return None
    if not isinstance(token, str) or token == "" or not _is_header_safe(token):
        return None
    return FileStore(_url=url, _token=token, stores=stores, reads=reads)


def _is_http_url(url: str) -> bool:
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and parts.netloc != ""


def _well_formed(text: str) -> str:
    """`text` with each lone surrogate as U+FFFD, as JavaScript's `toWellFormed` gives it: a name
    or an id from JSON can hold one, and UTF-8 can't encode it. A pair of surrogates stays one
    character."""
    return text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")


def _sendable_type(content_type: str) -> str:
    """The declared type as a header can carry it; the runtime decides by the bytes."""
    if content_type == "" or not _is_header_safe(content_type):
        return "application/octet-stream"
    return content_type


def _is_header_safe(value: str) -> bool:
    return all(char == "\t" or 0x20 <= ord(char) < 0x7F for char in value)


def _store_answer_of(response: httpx.Response) -> FileStoreAnswer:
    body = _json_of(response)
    if response.status_code != 200:
        raise _refused("files.store", response.status_code, body)
    if isinstance(body, Mapping):
        answer = cast("Mapping[str, Any]", body)
        if _is_file_value(answer.get("file")):
            return FileStoreAnswer(file=cast("Mapping[str, Any]", answer["file"]))
        reason = answer.get("notStored")
        if reason in _NOT_STORED_REASONS:
            return FileStoreAnswer(not_stored=reason)
    raise FileStoreError("files.store: the runtime's answer isn't a stored file or a reason")


def _read_answer_of(response: httpx.Response) -> FileReadAnswer:
    """The bytes (`application/octet-stream`), or why there are none (JSON)."""
    content_type = response.headers.get("content-type", "").lower()
    if response.status_code == 200 and content_type.startswith("application/octet-stream"):
        return FileReadAnswer(data=response.content)
    body = _json_of(response)
    if response.status_code != 200:
        raise _refused("files.read", response.status_code, body)
    if isinstance(body, Mapping):
        reason = cast("Mapping[str, Any]", body).get("notRead")
        if reason in _NOT_READ_REASONS:
            return FileReadAnswer(not_read=reason)
    raise FileStoreError("files.read: the runtime's answer isn't a file's bytes or a reason")


def _json_of(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None


def _refused(what: str, status: int, body: Any) -> FileStoreError:
    """A refusal's error, naming the status and the error code; never the token."""
    code = _error_code(body)
    return FileStoreError(
        f"{what}: the runtime answered {status}" + (f" ({code})" if code is not None else "")
    )


def _error_code(body: Any) -> str | None:
    if not isinstance(body, Mapping):
        return None
    error = cast("Mapping[str, Any]", body).get("error")
    if not isinstance(error, Mapping):
        return None
    code = cast("Mapping[str, Any]", error).get("code")
    return code if isinstance(code, str) else None


def _is_file_value(value: Any) -> bool:
    """A file value's shape, as `isFileValue` (`@kindgi/types`) checks it."""
    if not isinstance(value, Mapping):
        return False
    v = cast("Mapping[str, Any]", value)
    size, sha256, pages = v.get("size"), v.get("sha256"), v.get("pages", 1)
    return (
        v.get("type") == "kindgi.file"
        and isinstance(v.get("artifactId"), str)
        and v["artifactId"] != ""
        and isinstance(v.get("contentType"), str)
        and isinstance(size, int)
        and not isinstance(size, bool)
        and size >= 0
        and isinstance(sha256, str)
        and _SHA256_HEX.fullmatch(sha256) is not None
        and isinstance(v.get("name", ""), str)
        and isinstance(pages, int)
        and not isinstance(pages, bool)
        and pages >= 1
        and v.get("notShown", "type") in _FILE_NOT_SHOWN_REASONS
    )
