---
'@kindgi/env-schema': patch
---

**New runtime setting `KINDGI_AUTH_INVITE_EMAIL_DAILY_CAP`:** the deployment's backstop on invitation emails, at most this many in 24 hours from all its tenants together. Default 500, a whole number from 1 to 100000. Each tenant's own limit stays: 100 a day, or 10 while `KINDGI_PRODUCTION_GATE` is `on` and the tenant isn't allowed production. At a limit the person is still added, without the email (`inviteEmail.reason` is `capped`), and sending it again answers `429 invite-capped`. It needs the emailed sign-in link's sender: set without `KINDGI_AUTH_EMAIL_SMTP_URL` (or `…_PATH`), the runtime refuses to start. `AUTH_INVITE_EMAIL_DAILY_CAP_VAR` names it.
