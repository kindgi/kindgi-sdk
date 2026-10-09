---
"@kindgi/api": patch
---

Reading gate policies needs `read` on each policy's scope: its project (a segment's project), its org, or the tenant. That covers `GET /v1/gate-policies`, `/{id}`, `/{id}/versions` and `/{id}/versions/{version}`. The list shows only the policies the caller may read, and one they can't read answers `404 gate-policy-not-found`, as if it weren't there. Before, any signed-in principal in the tenant could read every gate policy when authorization was on, including another project's.
