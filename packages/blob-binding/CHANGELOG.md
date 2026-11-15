# @kindgi/blob-binding

## 0.7.0

### Patch Changes

- bb5bbf8: **Files with versions.** A runtime that keeps files serves `/v1/files`: a file is a name and its versions 1, 2, 3, each one stored blob, read by its number or by `latest`. The operations are `files.list`, `files.create`, `files.get`, `files.delete`, `files.versions.list`, `files.versions.add`, `files.versions.get`, `files.versions.download` (the bytes, with `X-Kindgi-File-Version`), `files.versions.restore`, `files.versions.delete`, `files.versions.pin`, `files.versions.unpin` and `files.pinHistory`. Adding or restoring a version takes an optional `expectedVersion`: when Latest isn't that version, nothing is written and the answer is `409 file-version-conflict`. Bytes that are Latest's add no version (`200`, `created: false`). A restore is a new version with an earlier version's bytes, type and tags, under Latest's name. A pinned version can't be deleted, nor a file with one (`409 file-version-pinned`), and a file's last live version goes only with the file (`409 file-last-version`). Reads need `read` on the file's project, or, for a person, `run` there for a file of their own; changes need `write`, except that a person with `run` can create a file of their own that names no run, to start a run with. An upload has the artifact upload's cap: over it is `413 file-too-large`.
  
  `createApp` takes the store as `fileVersions`, a `FileVersionsBinding` from `@kindgi/blob-binding` (its types are also exported by `@kindgi/api`); without one, `/v1/files` isn't mounted. A file's id is its version 1's `blobId`. `BlobMeta` gains `fileId` and `version`, for a blob that is a file's version, and `/v1/artifacts` answers carry them; deleting an artifact whose bytes a file still needs is `409 artifact-in-file`. `FileValue` in `@kindgi/types` takes `fileId` and `version`, both or neither, and `FileId` is a new id type. The retention domains gain `file_version`, opt-in like `memory` and `conversation`: a deleted version goes after the grace, and so does one that isn't Latest, isn't among its file's newest 10, isn't pinned, and was superseded longer ago than the grace. The error codes `file-not-found`, `file-version-not-found`, `file-version-conflict`, `file-version-pinned`, `file-last-version`, `file-too-large` and `artifact-in-file` are in the API's status map and the error codes reference, and the TypeScript client reads each as its kind.
  
  Deleting a file or a version that's already deleted answers `{ deleted: false }` and changes nothing; an id no file ever had is `404 file-not-found`. The version in a restore, delete, pin or unpin path is a whole number from 1. A `files.list` filter on `ownerRunId` or `projectId` that isn't an id is `400`. A version's `supersededAt` is when a newer version replaced it as Latest, so Latest has none. When two versions share bytes, the blob's `BlobMeta.version` names the lower one. The five `artifacts.*` operations are `deprecated: true` and go in 0.8.0, and every `/v1/artifacts` answer, a refused one too, carries a `Link` with `rel="deprecation"` to the docs' "What 0.8.0 removes", `concepts/files-and-versions/#what-080-removes` on the release's docs line. The TypeScript client's wire types keep a deprecated operation, since it's served until the release that removes it.
- 8cac758: **A put past the workspace's storage limit is refused, and an upload for a run that never starts is deleted.**
  - `BlobError` gains `storage-limit-reached`. A put that the workspace's storage limit has no room for stores nothing. The error carries the limit (`storageMiB`), what the workspace's files already take (`usedBytes`) and what the put needs (`neededBytes`). The API answers it with `403 storage-limit-reached`.
  - `BlobPutInput.forRun` marks an upload for a run that hasn't started yet. Such an upload is deleted once the deployment's unused-upload time has passed (24 hours by default), unless a run that names it has started by then. `BlobMeta.expiresAt` says when, and goes away once such a run starts.
  - `POST /v1/artifacts` takes `forRun=true` for such an upload, and its metadata, in the answer and wherever it's read, has `expiresAt` while it's unused. `forRun` with `ownerRunId`, or with a value other than `true` or `false`, is `400 bad-input`. An upload by someone who may run the project but not write to it is always one.
  - The TypeScript client's `artifacts.upload` takes `forRun`, and its `BlobMeta` has `expiresAt`. With the Python client, pass `data={"forRun": "true"}` to `artifacts.upload`; its `BlobMeta` has `expires_at`.
  - `TenantLimits.storageMiB` is the workspace's storage limit, in MiB, from 1 to 1000000. It's set and read like the other limits, on `PUT` and `GET /v1/system/tenants/:tenantId/limits`. Lowering it deletes no file.
  - `BlobStorageBinding.storageUsed`, optional, says what a tenant's files take, with the uploads under way. From a store that has it, `GET /v1/tenant` answers `storage: { usedBytes }`. A runtime that counts files adds `storageUsedBytes` to the limits read's `inUse`.
  - The env schema has `KINDGI_UNUSED_UPLOAD_TTL_MS`: how long an upload for a run is kept while no run that names it has started, in milliseconds, from 1 to 315360000000 (ten years). The default is 86400000 (24 hours). Runtimes before 0.7.0 ignore it.
- Updated dependencies [dfaeea7]
- Updated dependencies [f8a4191]
- Updated dependencies [2d279a5]
- Updated dependencies [bb5bbf8]
- Updated dependencies [524e626]
- Updated dependencies [c003626]
- Updated dependencies [6279526]
- Updated dependencies [439bffc]
- Updated dependencies [8cac758]
- Updated dependencies [15c2925]
- Updated dependencies [00afa37]
- Updated dependencies [25d902a]
  - @kindgi/types@0.7.0
  - @kindgi/platform@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [6707cb9]
- Updated dependencies [287c34c]
- Updated dependencies [7c10695]
  - @kindgi/types@0.6.0
  - @kindgi/platform@0.6.0

## 0.5.0

### Patch Changes

- 8327900: The doc comments and READMEs call the place a workspace, as the console and the API reference do, and so do the npm descriptions of `@kindgi/bounds` and `@kindgi/platform`. What you type keeps `tenant`: `tenantId`, `TenantHierarchyBinding` and `runOutsideTenant`. So does the multi-tenant text.
- Updated dependencies [1ed72e3]
- Updated dependencies [8327900]
- Updated dependencies [1365f49]
  - @kindgi/types@0.5.0
  - @kindgi/platform@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [b25b82f]
- Updated dependencies [d92355b]
- Updated dependencies [d6c9279]
- Updated dependencies [6380c49]
- Updated dependencies [f2adcc2]
- Updated dependencies [9b015f7]
- Updated dependencies [9a8a294]
- Updated dependencies [1bd877d]
- Updated dependencies [265fffb]
- Updated dependencies [d779ec5]
- Updated dependencies [dff9515]
- Updated dependencies [d576ff4]
  - @kindgi/types@0.4.0
  - @kindgi/platform@0.4.0

## 0.3.1

### Patch Changes

- @kindgi/platform@0.3.1
  - @kindgi/types@0.3.1

## 0.3.1-rc.1

### Patch Changes

- @kindgi/platform@0.3.1-rc.1
  - @kindgi/types@0.3.1-rc.1

## 0.3.1-rc.0

### Patch Changes

- @kindgi/platform@0.3.1-rc.0
  - @kindgi/types@0.3.1-rc.0

## 0.3.0

### Patch Changes

- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
  - @kindgi/platform@0.3.0
  - @kindgi/types@0.3.0

## 0.3.0-rc.0

### Patch Changes

- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
  - @kindgi/platform@0.3.0-rc.0
  - @kindgi/types@0.3.0-rc.0

## 0.2.0

### Patch Changes

- @kindgi/platform@0.2.0
  - @kindgi/types@0.2.0

## 0.2.0-rc.1

### Patch Changes

- @kindgi/platform@0.2.0-rc.1
  - @kindgi/types@0.2.0-rc.1

## 0.2.0-rc.0

### Patch Changes

- @kindgi/platform@0.2.0-rc.0
  - @kindgi/types@0.2.0-rc.0

## 0.1.10

### Patch Changes

- Updated dependencies [25a7309]
  - @kindgi/platform@0.1.10
  - @kindgi/types@0.1.10

## 0.1.10-rc.1

### Patch Changes

- @kindgi/platform@0.1.10-rc.1
  - @kindgi/types@0.1.10-rc.1

## 0.1.10-rc.0

### Patch Changes

- Updated dependencies [25a7309]
  - @kindgi/platform@0.1.10-rc.0
  - @kindgi/types@0.1.10-rc.0

## 0.1.9

### Patch Changes

- Updated dependencies [d563887]
- Updated dependencies [409b9bf]
  - @kindgi/platform@0.1.9
  - @kindgi/types@0.1.9

## 0.1.9-rc.1

### Patch Changes

- @kindgi/platform@0.1.9-rc.1
  - @kindgi/types@0.1.9-rc.1

## 0.1.9-rc.0

### Patch Changes

- Updated dependencies [d563887]
- Updated dependencies [409b9bf]
  - @kindgi/platform@0.1.9-rc.0
  - @kindgi/types@0.1.9-rc.0

## 0.1.8

### Patch Changes

- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
  - @kindgi/platform@0.1.8
  - @kindgi/types@0.1.8

## 0.1.8-rc.0

### Patch Changes

- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
  - @kindgi/platform@0.1.8-rc.0
  - @kindgi/types@0.1.8-rc.0

## 0.1.7

### Patch Changes

- Updated dependencies [b90e2c6]
- Updated dependencies [b90e2c6]
  - @kindgi/types@0.1.7
  - @kindgi/platform@0.1.7

## 0.1.7-rc.0

### Patch Changes

- Updated dependencies [b90e2c6]
- Updated dependencies [b90e2c6]
  - @kindgi/types@0.1.7-rc.0
  - @kindgi/platform@0.1.7-rc.0

## 0.1.6

### Patch Changes

- Updated dependencies [b4bbd95]
- Updated dependencies [307771f]
  - @kindgi/types@0.1.6
  - @kindgi/platform@0.1.6

## 0.1.6-rc.0

### Patch Changes

- Updated dependencies [b4bbd95]
- Updated dependencies [307771f]
  - @kindgi/types@0.1.6-rc.0
  - @kindgi/platform@0.1.6-rc.0

## 0.1.5

### Patch Changes

- 490d083: Artifacts belong to a project, and the capability catalog says what each feature means and which of your models have it.
  - **Artifacts (`/v1/artifacts`):**
    - Every artifact belongs to a project: its owner run's, else the upload's new `projectId`, else the tenant's default project. `BlobMeta` carries `projectId` and `createdBy`, and `BlobPutInput` takes them (both optional).
    - With authorization on, listing and downloading need `read` on that project, and uploading and deleting need `write`.
      - An artifact the caller can't read is `404`, as if absent.
      - A list shows only what the caller can read. `?projectId=` narrows it.
    - An upload naming an owner run that doesn't exist is `404 run-not-found`. A `projectId` that isn't the owner run's project is `400`.
    - The runtime caps an upload: `413 artifact-too-large`, with `details.maxBytes`. `CreateAppInput.artifactMaxBytes` sets it (default 100 MB).
  - **Retention domain `artifact`:** a retention policy can purge deleted artifacts after its grace.
  - **Capabilities:**
    - `FEATURE_DESCRIPTIONS` (`@kindgi/capabilities`) says in a line what each of the 13 features means.
    - A `CapabilityDescriptor` may carry `providers: [{providerId, models}]`, the tenant's providers with a model that has the feature (optional in the spec).
  - **TypeScript client:**
    - `artifacts.upload` (multipart), `download` (streamed bytes) and `head`; `list` takes `projectId`.
    - `put` and `get` (content-addressed `BlobRef`s) have no API route: they throw, pointing to `upload` and `download`.
    - `artifact-too-large` is an invalid request.
  - **Python client:** the new fields; a 413 is an `InvalidRequestError`.
  - **Runtime settings (`@kindgi/env-schema`):**
    - `KINDGI_ARTIFACTS` is `local:<absolute dir>` or `gcs:<bucket>[/<prefix>]`; it turns on `/v1/artifacts`.
    - `KINDGI_ARTIFACT_MAX_BYTES` sets the upload cap.
    - `kindgi dev` sets artifacts to the pack's `.kindgi/dev/artifacts`, which is gitignored.
  - **CLI:**
    - `kindgi artifacts list|get|upload|download|delete` and `kindgi capabilities list|get` work; before, they were hidden.
    - `artifacts head` is folded into `get`.
- Updated dependencies [eff6249]
  - @kindgi/types@0.1.5
  - @kindgi/platform@0.1.5

## 0.1.5-rc.0

### Patch Changes

- 490d083: Artifacts belong to a project, and the capability catalog says what each feature means and which of your models have it.
  - **Artifacts (`/v1/artifacts`):**
    - Every artifact belongs to a project: its owner run's, else the upload's new `projectId`, else the tenant's default project. `BlobMeta` carries `projectId` and `createdBy`, and `BlobPutInput` takes them (both optional).
    - With authorization on, listing and downloading need `read` on that project, and uploading and deleting need `write`.
      - An artifact the caller can't read is `404`, as if absent.
      - A list shows only what the caller can read. `?projectId=` narrows it.
    - An upload naming an owner run that doesn't exist is `404 run-not-found`. A `projectId` that isn't the owner run's project is `400`.
    - The runtime caps an upload: `413 artifact-too-large`, with `details.maxBytes`. `CreateAppInput.artifactMaxBytes` sets it (default 100 MB).
  - **Retention domain `artifact`:** a retention policy can purge deleted artifacts after its grace.
  - **Capabilities:**
    - `FEATURE_DESCRIPTIONS` (`@kindgi/capabilities`) says in a line what each of the 13 features means.
    - A `CapabilityDescriptor` may carry `providers: [{providerId, models}]`, the tenant's providers with a model that has the feature (optional in the spec).
  - **TypeScript client:**
    - `artifacts.upload` (multipart), `download` (streamed bytes) and `head`; `list` takes `projectId`.
    - `put` and `get` (content-addressed `BlobRef`s) have no API route: they throw, pointing to `upload` and `download`.
    - `artifact-too-large` is an invalid request.
  - **Python client:** the new fields; a 413 is an `InvalidRequestError`.
  - **Runtime settings (`@kindgi/env-schema`):**
    - `KINDGI_ARTIFACTS` is `local:<absolute dir>` or `gcs:<bucket>[/<prefix>]`; it turns on `/v1/artifacts`.
    - `KINDGI_ARTIFACT_MAX_BYTES` sets the upload cap.
    - `kindgi dev` sets artifacts to the pack's `.kindgi/dev/artifacts`, which is gitignored.
  - **CLI:**
    - `kindgi artifacts list|get|upload|download|delete` and `kindgi capabilities list|get` work; before, they were hidden.
    - `artifacts head` is folded into `get`.
- Updated dependencies [eff6249]
  - @kindgi/types@0.1.5-rc.0
  - @kindgi/platform@0.1.5-rc.0

## 0.1.4

### Patch Changes

- Updated dependencies [fac7472]
- Updated dependencies [26b2a23]
- Updated dependencies [7a8e764]
- Updated dependencies [2040daf]
- Updated dependencies [71412f6]
- Updated dependencies [06b5fc0]
- Updated dependencies [e17b230]
- Updated dependencies [e7e2f86]
- Updated dependencies [3d23304]
- Updated dependencies [ae417f7]
  - @kindgi/types@0.1.4
  - @kindgi/platform@0.1.4

## 0.1.4-rc.5

### Patch Changes

- @kindgi/platform@0.1.4-rc.5
  - @kindgi/types@0.1.4-rc.5

## 0.1.4-rc.4

### Patch Changes

- @kindgi/platform@0.1.4-rc.4
  - @kindgi/types@0.1.4-rc.4

## 0.1.4-rc.3

### Patch Changes

- @kindgi/platform@0.1.4-rc.3
  - @kindgi/types@0.1.4-rc.3

## 0.1.4-rc.2

### Patch Changes

- Updated dependencies [2040daf]
- Updated dependencies [71412f6]
- Updated dependencies [e7e2f86]
- Updated dependencies [ae417f7]
  - @kindgi/types@0.1.4-rc.2
  - @kindgi/platform@0.1.4-rc.2

## 0.1.4-rc.1

### Patch Changes

- Updated dependencies [06b5fc0]
  - @kindgi/platform@0.1.4-rc.1
  - @kindgi/types@0.1.4-rc.1

## 0.1.4-rc.0

### Patch Changes

- Updated dependencies [fac7472]
- Updated dependencies [26b2a23]
- Updated dependencies [7a8e764]
- Updated dependencies [e17b230]
- Updated dependencies [3d23304]
  - @kindgi/types@0.1.4-rc.0
  - @kindgi/platform@0.1.4-rc.0

## 0.1.3

### Patch Changes

- Updated dependencies [1463b77]
  - @kindgi/types@0.1.3
  - @kindgi/platform@0.1.3

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- Updated dependencies [966a615]
  - @kindgi/platform@0.1.2
  - @kindgi/types@0.1.2

## 0.1.1

### Patch Changes

- @kindgi/platform@0.1.1
  - @kindgi/types@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/types@0.1.0
  - @kindgi/platform@0.1.0
