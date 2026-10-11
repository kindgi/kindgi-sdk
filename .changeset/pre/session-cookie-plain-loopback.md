---
"@kindgi/api": patch
---

Browser sessions can use a plain session cookie in development on a loopback address, so Safari can sign in to a console at `http://localhost` or `http://127.0.0.1`. Safari keeps a `Secure` cookie only over https, even on localhost.
- **`SessionCookieOptions.secure`** (default `true`). With `false`, the cookie is `kindgi_session` (`PLAIN_SESSION_COOKIE_NAME`; `__Host-` needs `Secure`). It's still `HttpOnly` and `SameSite=Lax`, and the middleware reads only that name. Where the cookie is `Secure`, a plain `kindgi_session` never counts. `createApp` refuses `secure: false` with a `__Host-` or `__Secure-` name.
- **`GET /v1/auth/sign-in-options`** answers `methods.sessionCookie`: `secure` or `plain`, wherever there are browser sessions. A sign-in page can check the browser keeps that kind of cookie before offering sign-in. It's absent from older servers: treat that as `secure`.
