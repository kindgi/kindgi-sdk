---
"@kindgi/api": patch
"@kindgi/platform": patch
---

A project's admins can no longer give the `owner` role, or change or remove a member who holds it: with authorization enforced, that takes `delete` on the project, which an owner of the project, an admin of its org or a tenant admin holds. Anyone else gets `403 permission-denied` from `POST`, `PATCH` and `DELETE` on `/v1/projects/{projectId}/memberships`, and nothing changes. A request that gives `owner` is checked before the person it names is looked up. Changing or removing anyone else asks for nothing more than before. `RemoveProjectMemberParams` (and so `UpdateProjectMemberRoleParams`) gains `stopAtOwner`, and `MembershipWriteError` gains the code `project-member-holds-owner`: the routes set `stopAtOwner`, and a binding answers that code, writing nothing, when the member holds `owner`. A `TenantHierarchyBinding` of your own that holds project roles must honor `stopAtOwner`, or a project's admins can still lower or remove an owner through it.
