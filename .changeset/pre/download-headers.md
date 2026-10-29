---
"@kindgi/api": patch
---

**Stored bytes are never opened as a page of the API's origin.** `GET /v1/artifacts/{blobId}` and its `HEAD` answer an attachment (`Content-Disposition: attachment`, with the name as an ASCII `filename` and in full as a UTF-8 `filename*`), `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`. An S3 object read (`GET` and `HEAD /s3/{bucket}/{key}`, a presigned link's included) answers `nosniff` too: an object of a type a browser shows without running it (PNG, JPEG, GIF, WebP, AVIF, PDF, plain text, MP3, Ogg, WAV, WebM and MP4 audio, and MP4, WebM and Ogg video) stays inline, and any other is an attachment, sandboxed the same way. The `response-content-type` and other response override parameters aren't read. Both serve a stored type as itself when it's a well-formed media type of at most 255 characters, else as `application/octet-stream`; a stored type with a line break in it made the download fail.
