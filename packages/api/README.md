# @kindgi/api

REST + SSE HTTP surface for the Kindgi platform. Exposes the runtime
(kernel, agents, HITL, supervisor — reached through the bindings passed
to `createApp`) behind two wire faces:

- **`/v1/*`** — the Kindgi REST API. JSON in, JSON out. Bearer
  token auth. Documented via OpenAPI 3.1 (snapshot shipped as `@kindgi/api/openapi.json`).
  Conventions locked in [`docs/API-ROUTE-CONVENTIONS.md`](../../docs/API-ROUTE-CONVENTIONS.md).
- **`/s3/*`** — AWS S3 API v4 wire surface. XML in,
  XML out. SigV4 auth. Documented in this file.

Both surfaces route through the same runtime bindings — an artifact
uploaded via one is readable via the other. Deployments enable
either or both via `createApp(...)` bindings.

## `createApp(input)`

Assemble the Hono app instance. Every runtime dependency is caller-
plugged; the API package does not own persistence. See
[`src/app.ts`](src/app.ts) for the full `CreateAppInput` shape.

Minimal wiring for BOTH surfaces:

```ts
import { createApp } from '@kindgi/api';

const app = createApp({
  // Required runtime bindings — supplied by the Kindgi runtime in a
  // deployment; `createStubAppBindings()` from @kindgi/testing in tests.
  ...runtimeBindings,
  resolveToken: async (token) => /* ... */,
  runHandler: /* ... */,
  blobStorage, // any BlobStorageBinding (filesystem, S3, GCS, …)
  s3Credentials: {
    async resolve(accessKeyId) {
      // Deployment-owned lookup — return { secretKey, tenantId, bucket }
      // or null for unknown / revoked.
      return await lookupAccessKey(accessKeyId);
    },
  },
});
```

Omit `s3Credentials` → the `/s3/*` mount is skipped (Hono 404).
Omit `blobStorage` → both `/v1/artifacts` AND `/s3` are skipped.

## Interactive docs (Scalar)

Set `openapi.docs` on `createApp(...)` to mount a Scalar-rendered
interactive API reference alongside the JSON spec. The docs page reads
the (already-public) `/v1/openapi.json` in the browser, so it sits on
the public side of the auth chain — no bearer required to browse.

```ts
const app = createApp({
  ...runtimeBindings,
  resolveToken: /* ... */,
  runHandler: /* ... */,
  openapi: { docs: true },          // → mounts /docs (default path)
});

// Or customize:
openapi: { docs: { path: '/reference', title: 'Acme Legal API' } }
```

`docs` is opt-in — omit it and the docs UI is unmounted (Hono 404). The
JSON spec at `/v1/openapi.json` is always mounted independent of this
flag.

## The `/s3/*` mount

Any S3-aware client (`aws s3 cp`, `rclone`, `mc`, aws-sdk-js, boto3)
hits `/s3/*` with zero code changes. The server verifies AWS Signature
Version 4 itself (`node:crypto`; see
[`src/middleware/sigv4-verify.ts`](src/middleware/sigv4-verify.ts)).

### Auth model

Every `/s3/*` request carries SigV4 credentials, either as:

- **Header auth** — `Authorization: AWS4-HMAC-SHA256 Credential=<accessKeyId>/<date>/<region>/s3/aws4_request, SignedHeaders=..., Signature=<hex>`
- **Presigned URL** — query params `X-Amz-Algorithm=AWS4-HMAC-SHA256`,
  `X-Amz-Credential=...`, `X-Amz-Date=...`, `X-Amz-Expires=...`,
  `X-Amz-SignedHeaders=...`, `X-Amz-Signature=...`.

The middleware:

1. Parses the auth params (header OR presigned).
2. Checks the signed timestamp and credential scope: within ±15 minutes
   of the server clock for header auth (`RequestTimeTooSkewed`
   otherwise); presigned URLs until `X-Amz-Expires`.
3. Calls `S3CredentialBinding.resolve(accessKeyId)` → resolves to
   `{ secretKey, tenantId, bucket, expiresAt? }` or `null`.
4. For header auth, verifies `x-amz-content-sha256` matches the
   received body — returns `400 XAmzContentSHA256Mismatch` on payload
   tampering before signature comparison.
5. Re-derives the signature under `secretKey` from exactly what the
   client signed (its timestamp and its `SignedHeaders`) and compares
   it in constant time.
6. Compares the URL-declared bucket to the credential's `bucket`
   field. Mismatch → `403 AccessDenied` (each credential is scoped to
   one bucket).
7. Sets `c.set('tenantId', ...)` + `c.set('bucket', ...)` for the
   downstream S3 route handlers.

All auth failures return S3-style XML errors
(`<Error><Code>...</Code>...</Error>`) with `Content-Type: application/xml`.

### Supported operations

Object routes (bucket + key):

| Verb   | Path                              | Op                       |
|---     |---                                |---                       |
| PUT    | `/s3/:bucket/*`                   | PutObject                |
| GET    | `/s3/:bucket/*`                   | GetObject                |
| HEAD   | `/s3/:bucket/*`                   | HeadObject               |
| DELETE | `/s3/:bucket/*`                   | DeleteObject             |

Bucket routes:

| Verb   | Path              | Op                                |
|---     |---                |---                                |
| HEAD   | `/s3/:bucket`     | HeadBucket                        |
| GET    | `/s3/:bucket`     | ListObjectsV2 (requires `?list-type=2`) |

Multipart upload (S3-standard `md5(concat(md5(part_i)))-N` ETag):

| Verb   | Path                                     | Op                          |
|---     |---                                       |---                          |
| POST   | `/s3/:bucket/*?uploads`                  | InitiateMultipartUpload     |
| PUT    | `/s3/:bucket/*?partNumber=&uploadId=`    | UploadPart                  |
| POST   | `/s3/:bucket/*?uploadId=`                | CompleteMultipartUpload     |
| GET    | `/s3/:bucket/*?uploadId=`                | ListParts                   |
| DELETE | `/s3/:bucket/*?uploadId=`                | AbortMultipartUpload        |

Semantic notes:

- **Content-MD5** on PUT (regular OR part upload) is verified;
  mismatch → `400 BadDigest`.
- **Range** requests on GET support single-range only (`bytes=N-M`,
  `bytes=N-`, `bytes=-M`) — response is `206 Partial Content` with
  `Content-Range: bytes N-M/total`. Multi-range (comma-separated)
  requests are rejected with `416 InvalidRange`.
- **DELETE** always returns `204` — whether the key existed or not
  (S3 semantics).
- **ListObjectsV2** requires `?list-type=2`; v1 listing is not
  implemented (returns `501 NotImplemented`). `?prefix=`,
  `?max-keys=`, `?continuation-token=` are honored.
- **x-amz-tagging** header on PUT is form-encoded
  (`key1=val1&key2=val2`) and stored as `BlobMeta.tags`. The
  dedicated `?tagging` subresource verbs are not implemented.

### Cross-surface interop

Every persisted blob carries BOTH a `blobId` (UUID) AND a
`(bucket, key)` pair. Bespoke uploads via `POST /v1/artifacts` land
under `bucket: 'artifacts', key: <blobId>` by default — S3
credentials granted the `artifacts` bucket see them via
`s3://artifacts/<blobId>`.

Conversely, S3 uploads via `PUT /s3/:bucket/:key` are visible in
`GET /v1/artifacts` listings under the same `blobId` and are
downloadable via `GET /v1/artifacts/:blobId`.

### Errors (S3-style XML)

| HTTP | S3 Code                          | When                                     |
|---   |---                               |---                                       |
| 400  | `InvalidRequest`                 | Malformed request                        |
| 400  | `MalformedXML`                   | `CompleteMultipartUpload` body invalid   |
| 400  | `InvalidArgument`                | Bad query param (e.g. `partNumber` OOB)  |
| 416  | `InvalidRange`                   | Bad `Range` header                       |
| 400  | `BadDigest`                      | `Content-MD5` mismatch                   |
| 400  | `XAmzContentSHA256Mismatch`      | Payload hash header mismatch             |
| 400  | `InvalidPart`                    | Multipart part ETag mismatch             |
| 403  | `AccessDenied`                   | Credential expired / wrong bucket        |
| 403  | `InvalidAccessKeyId`             | Unknown access key                       |
| 403  | `SignatureDoesNotMatch`          | SigV4 verification failed                |
| 403  | `RequestTimeTooSkewed`           | Signed timestamp outside the ±15 min window |
| 403  | `InvalidRequest`                 | Malformed SigV4 authorization            |
| 400  | `AuthorizationQueryParametersError` | Malformed presigned-URL parameters    |
| 404  | `NoSuchKey`                      | Unknown key                              |
| 404  | `NoSuchUpload`                   | Unknown or aborted `uploadId`            |
| 501  | `NotImplemented`                 | Unsupported operation                    |
| 500  | `InternalError`                  | Backing store failure                    |

## Development

```sh
pnpm --filter @kindgi/api build       # compile TS + emit dist
pnpm --filter @kindgi/api typecheck   # no-emit typecheck
pnpm --filter @kindgi/api test        # vitest run
pnpm --filter @kindgi/api gen:openapi # regenerate packages/api/openapi.json
```

`gen:openapi` documents the `/v1/*` surface only. The `/s3/*` surface
follows the S3 wire (XML, AWS-native SDKs) and is intentionally NOT
in the OpenAPI document — consumers use their own S3 SDKs pointed at
the mount.

## Adapters (production-readiness plug-ins)

`createApp(...)` bindings are caller-plugged so this package can stay
free of persistence choices. The Kindgi runtime ships production
implementations (e.g. a Postgres-backed `idempotencyStore` whose retries
survive restarts and multi-instance deployments, filesystem and object-store
`blobStorage`). This package includes `createInMemoryIdempotencyStore()`,
which is correct for dev + tests.

## See also

- [`docs/API-ROUTE-CONVENTIONS.md`](../../docs/API-ROUTE-CONVENTIONS.md)
  — locked URL / auth / error-envelope / pagination / SSE conventions
  for `/v1/*`.
- [`docs/ADDING-A-ROUTE.md`](../../docs/ADDING-A-ROUTE.md) — how to add
  a new `/v1/*` route.
