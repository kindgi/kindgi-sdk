---
"@kindgi/env-schema": patch
---

New runtime settings for "Continue with Google / Microsoft / GitHub" with the deployment's own apps: `KINDGI_AUTH_GOOGLE_CLIENT_ID` and `KINDGI_AUTH_GOOGLE_CLIENT_SECRET` (or `…_SECRET_PATH`), and the same for `MICROSOFT` and `GITHUB`. People who've been added to a workspace sign in with that account, by its verified email. Google and Microsoft speak for a company's email only through the company's own accounts (a Google Workspace account of that domain, a Microsoft work account): a personal account made on a work address is refused. A Microsoft app needs the ID-token optional claims `email` and `xms_edov`; without `xms_edov`, Microsoft sign-ins are refused. On the domains of a workspace that signs its people in with its own identity provider, GitHub and the emailed link are not offered or accepted.
