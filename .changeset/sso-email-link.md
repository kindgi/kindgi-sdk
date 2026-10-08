---
"@kindgi/env-schema": patch
---

New runtime settings for the emailed sign-in link: `KINDGI_AUTH_EMAIL_SMTP_URL` (or `…_PATH`) and `KINDGI_AUTH_EMAIL_FROM` turn it on. People who've been added to a workspace can then ask for a one-time link by email, valid for ten minutes. Optionally, `KINDGI_AUTH_TURNSTILE_SECRET` (or `…_PATH`) with `KINDGI_AUTH_TURNSTILE_SITE_KEY` puts a Cloudflare Turnstile check on asking for one.
