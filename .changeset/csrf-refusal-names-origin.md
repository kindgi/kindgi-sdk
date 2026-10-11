---
'@kindgi/api': patch
---

A cookie-signed request refused for its origin (`403 csrf-origin-mismatch`) now names the address to use: "A request signed in by the session cookie can't come from http://localhost:4000; open the console at http://127.0.0.1:4000". The address is the first allowed origin. A server that checks same-origin only, with no list, keeps the old message.
