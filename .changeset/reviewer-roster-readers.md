---
"@kindgi/api": patch
---

**The reviewer roster is for those who decide approvals.** With authorization on, `GET /v1/approvals/reviewers` (and `/:reviewerId`) needed only a valid token, so any member, a project's viewer included, could see who reviews. It names people: a tenant admin or a reviewer (a role on the token, or one the roster gives the user) reads it now, and anyone else gets `403 permission-denied`, recorded in the access audit. Registering and unregistering still need a tenant admin.
