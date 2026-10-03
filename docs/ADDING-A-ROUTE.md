# Adding an HTTP route

Checklist for adding (or changing) a `/v1/*` route in `@kindgi/api` and
exposing it through the TypeScript SDK (`@kindgi/client`). Every step has
an automated gate; the table at the end lists them.

Conventions for URL shape, auth, request / response bodies, pagination,
and errors are in [`API-ROUTE-CONVENTIONS.md`](./API-ROUTE-CONVENTIONS.md).
Read it first.

## 1. Implement the handler

- Add the handler to the resource's router in
  `packages/api/src/routes/<resource>.ts` (create the file for a new
  resource and mount it in `packages/api/src/app.ts`).
- If the route needs a capability the API doesn't have yet (storage, a
  runtime service), add a binding interface to the relevant public
  package and a field on `CreateAppInput`. The host application supplies
  the implementation — `@kindgi/api` never constructs one itself.

## 2. Register the operation

Add one `OperationSpec` to `OPERATIONS` in
`packages/api/src/openapi/operations.ts`:

- `method`, `honoPath` (`:id` style, exactly as mounted), `openapiPath`
  (`{id}` style)
- `operationId` as `<resource>.<verb>`, `summary`, `tags`, `security`
  (`'bearer'` unless the route is deliberately public)
- `parameters`, `requestBody`, `responses` — schemas are `$ref`s into
  `components.schemas`; add new wire shapes to
  `packages/api/src/openapi/schemas.ts`

**Gate:** `tests/openapi.test.ts` fails when a mounted route has no
`OPERATIONS` entry or an entry has no mounted route. The pre-commit hook
runs it whenever staged files touch `packages/api/src/{routes,openapi}/`.

## 3. Regenerate the OpenAPI artifact

```sh
pnpm --filter @kindgi/api gen:openapi
```

This rewrites `packages/api/openapi.json` (exported as
`@kindgi/api/openapi.json` — the SDK codegen input). Commit it with the
route change.

**Gate:** `packages/api/tests/openapi-artifact.test.ts` fails in CI when
the committed file differs from the generator output.

## 4. Test the route

Add or extend `packages/api/tests/<resource>-routes.test.ts`: success
path, auth / tenant scoping, validation errors, and not-found / conflict
cases per the conventions doc.

## 5. Wrap it in the SDK

- `pnpm --filter @kindgi/client gen` regenerates the wire types from the
  artifact (`build` runs it automatically).
- Add the resource-client method in
  `sdks/typescript/src/resources/<resource>.ts` and its test.
- Add an entry under `## Unreleased` in `sdks/typescript/CHANGELOG.md`.
- Regenerate the Python client: `cd sdks/python && uv run python scripts/gen_client.py`.
  Every operation becomes a method there (models and resources are generated);
  nothing to hand-write.

**Gate:** `sdks/typescript/tests/coverage-drift.test.ts` fails when a
generated endpoint has no resource-client method. An endpoint that is
deliberately not wrapped goes in that test's `SKIP` map with a reason.
The pre-commit hook runs it when the API or `sdks/typescript/src/`
changes.

## Gates at a glance

| Gate | Catches | Runs in |
|---|---|---|
| `packages/api/tests/openapi.test.ts` | route ↔ `OPERATIONS` drift | pre-commit (API changes), CI |
| `packages/api/tests/openapi-artifact.test.ts` | stale `openapi.json` | CI |
| `sdks/typescript/tests/coverage-drift.test.ts` | generated endpoint without SDK method | pre-commit (API / SDK changes), CI |
| `sdks/python/scripts/gen_client.py --check` | Python client out of step with `openapi.json` | pre-commit (API / Python client changes, with `uv`), CI |
