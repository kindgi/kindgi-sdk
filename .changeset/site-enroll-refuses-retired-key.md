---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
---

**A site can't enroll a key it retired.** `POST /v1/auth/sites/enroll` answers `409 site-enrollment-key-retired` for a key the site retired, by its RFC 7638 thumbprint, whatever retired it: an admin's `revoke-key`, or a newer key's enroll. It also refuses a key that another of the workspace's sites at the same address (origin) retired and holds no live entry for. A key that's live on the site now enrolls, as before. The refusal comes only once the code checks out, so a caller without a good code still gets `401 site-enrollment-refused`, and it doesn't use the code up: the same code works with a new key until it expires. `SiteEnrollOutcome` gains `{ kind: 'key-retired' }`, which a runtime that doesn't check never returns. `kindgi sites code` and `kindgi sites revoke-key` say so, and so do the `revokeKey` and `auth.sites.enroll` operations and the TypeScript client's `enrollSite`. The WordPress plugin says where to set a new key when Kindgi refuses one set in `wp-config.php` or the environment, and that the same code still works.
