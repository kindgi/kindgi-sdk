---
'@kindgi/api': patch
'@kindgi/platform': patch
'@kindgi/env-schema': patch
---

A person a site signs in holds only the grants their site's sign-in writes. A deployment's bindings refuse any other grant naming such a person with `site-person-grants-managed`, and the API answers it as `403` on six routes:
- adding a project or team member, or changing their role (`AddProjectMemberError`, `AddTeamMemberError` and `MembershipWriteError` gain the code);
- granting tenant admin (`PersonGrantErrorCode`);
- registering a reviewer (`ReviewerRegisterOutcome` gains a `refused` outcome).

`@kindgi/env-schema` gains `KINDGI_SITE_SIGN_IN`: `true` lets sites sign their people in. The runtime needs authorization enforced and `KINDGI_PUBLIC_URL` for it; it's off by default.
