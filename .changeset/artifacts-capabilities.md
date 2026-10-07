---
"@kindgi/api": patch
"@kindgi/blob-binding": patch
"@kindgi/capabilities": patch
"@kindgi/cli": patch
"@kindgi/client": patch
"@kindgi/policy-contract": patch
---

Artifacts belong to a project, and the capability catalog says what each feature means and which of your models have it.
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
  - `put` and `get` stay unwired and point at `upload`/`download`.
  - `artifact-too-large` is an invalid request.
- **Python client:** the new fields; a 413 is an `InvalidRequestError`.
- **CLI:**
  - `kindgi artifacts list|get|upload|download|delete` and `kindgi capabilities list|get` are wired; they were hidden as unwired.
  - `artifacts head` is folded into `get`.
