---
"@kindgi/api": patch
---

**A `HEAD` on an artifact or an S3 object reads its metadata only, and no longer leaves the object open.**

Hono answers a `HEAD` with the `GET` route at its path and drops the body. So `HEAD /v1/artifacts/{blobId}` and S3 `HeadObject` (`HEAD /s3/{bucket}/{key}`) ran the download: each opened the blob through the storage binding (`get`, `getByKey`), and nothing read or closed it. On a filesystem store each such `HEAD` left a file handle open for the life of the process; an object store's binding can hold its connection the same way. The routes' own `HEAD` handlers never ran.

Now each `GET` route answers a `HEAD` itself, from the binding's metadata-only read (`head`, `headByKey`), and never opens the blob. A `HEAD` answers the same status and headers as before, which are the `GET`'s:
- an artifact: `200` with `Content-Type`, `Content-Length`, `X-Kindgi-Blob-Hash` and `X-Kindgi-Blob-Name`, or the `GET`'s `404 blob-not-found`;
- an S3 object: `200` with `Content-Type`, `Content-Length`, `ETag`, `Last-Modified`, `Accept-Ranges` and the `x-amz-meta-*` headers; with a `Range`, the `206` headers or `416 InvalidRange`; or `404 NoSuchKey`.

A `GET` of an S3 object with a malformed `Range` now cancels the object it opened before it answers `416 InvalidRange`, where it left it open too.
