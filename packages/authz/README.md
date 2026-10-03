# `@kindgi/authz`

Public authorization shape for Kindgi™: the vocabulary and interfaces that callers, policy enforcement points (PEPs) and policy executors share. Object types, actions and relation names follow an OpenFGA-style model; the FGA store and the check implementation are supplied by the deployment. [`@kindgi/api`](../api/) uses these types in its middleware and bindings.

## Purpose

Give every enforcement site one vocabulary — which object types exist, which actions apply to each, how an action maps to an FGA relation, who the caller is — so a check means the same thing in every layer. The package is types and pure functions only; it holds no runtime state.

## Exports

- **Vocabulary** — `OBJECT_TYPES` / `ObjectType`, `ACTIONS` / `Action`, `ACTION_TO_RELATION` (e.g. `read` → `can_read`), `OBJECT_ACTIONS` (the actions meaningful per object type, so a PEP can reject `rotate` on an agent before calling FGA), `ResourceRef`, `resourceKey(ref)`, `ref(type, id)`.
- **Principals** — `Principal` (`actor`, optional `onBehalfOf`, optional `scope`), `PrincipalRef`, `PrincipalKind` (`user`, `agent`, `service_account`, `system`), `DownscopedPermissions` (`allowedActions` / `deniedActions`).
  - `userPrincipal`, `systemPrincipal`, `serviceAccountPrincipal`, `delegate(actor, onBehalfOf, scope?)` (throws on cross-tenant delegation), `downscope(principal, scope)`.
  - `fgaSubject(ref)` — the FGA subject string for a principal; `system` maps to `user:system`.
- **PEP helpers** — `principalFromToken(token)` (a `userId` gives a user principal, else a `tokenId` gives a service-account principal, else it throws), `TokenLike`, `denyPayload(action, type, id, reason)` / `DenyPayload` (the structured 403 body, `code: 'permission-denied'`).
- **Decisions** — `AuthzCheckBinding` with `check(principal, action, resource, ctx?)` and `checkBatch(...)`, `AuthzCheckContext` (`correlationId`, `runId`), and `Decision` (`allowed`, `reason`, `failing`, `evidence`). The effective permission is the intersection of actor, `onBehalfOf` and `scope`.
- **Tuples** — `TupleIntent` and `TupleEnqueueHook` (the hook every content and config binding calls inside its write transaction).
  - `tuplesForCreate(entity, creatorUserId?)` / `tuplesForDelete(entity)` over `EntityRef`; `tuplesForDelete` removes only the parent / scope tuple.
  - Subject and object helpers (`userSubject`, `teamMemberSubject`, `tenantObject` … `runObject`, `scopeSubject`) and the tuple-side `Scope`.
  - Membership and grants: `teamMembershipTuple`, `projectMembershipTuple`, `teamProjectGrantTuple` (`TeamRole`, `ProjectRole`), `machineAccessTuple` for `agent` / `service_account` subjects (`MachineSubject`, `AgentAccessResource`), and its agent shorthand `agentAccessTuple`.
- **Reviewer roles** — `ReviewerRole` (`standard`, `senior`, `admin`) and `REVIEWER_ROLE_RANK`, where a higher rank covers the lower ones.

## Example

```ts
import {
  type AuthzCheckBinding,
  type TupleEnqueueHook,
  denyPayload,
  principalFromToken,
  ref,
  tuplesForCreate,
} from '@kindgi/authz';
import type { ProjectId, TenantId, UserId } from '@kindgi/types';

const tenantId = 'acme' as TenantId;
const creator = 'user-1' as UserId;
const principal = principalFromToken({ tenantId, userId: creator });

// A project binding calls this inside its write transaction with the new row id:
// a `parent` tuple (tenant:acme → project) plus an `owner` tuple for the creator.
const enqueueTuples: TupleEnqueueHook = (rowId) =>
  tuplesForCreate({ kind: 'project', id: rowId as ProjectId, tenantId }, creator);

// At a PEP: ask the decision point, and turn a deny into the structured 403 body.
async function authorizeDelete(authz: AuthzCheckBinding, projectId: string) {
  const decision = await authz.check(principal, 'delete', ref('project', projectId), {
    correlationId: 'req-42',
  });
  return decision.allowed ? undefined : denyPayload('delete', 'project', projectId, decision.reason);
}
```

## Non-goals

- **The check implementation and the FGA store.** `AuthzCheckBinding` is an interface; the authorization model, the store and the worker that applies queued tuples are supplied by the deployment.
- **HTTP middleware.** `principalFromToken` and `denyPayload` are framework-neutral; the Hono middleware lives in `@kindgi/api`.
- **Cross-tenant delegation.** `delegate` throws when the actor and `onBehalfOf` belong to different tenants.

## Related

- [`@kindgi/api`](../api/) — the middleware, `TokenResolution`, and the bindings that call `TupleEnqueueHook`.
- [`@kindgi/types`](../types/) — the branded ids used in `EntityRef` and `PrincipalRef`.

## License

Apache License 2.0 — see [LICENSE](./LICENSE).
