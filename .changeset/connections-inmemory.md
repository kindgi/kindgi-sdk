---
"@kindgi/connections-inmemory": patch
---

**A new package: `@kindgi/connections-inmemory`.** An in-memory `ConnectionBinding` and `ConnectionResolver`, sharing one store, with a fake app in place of Google's or GitHub's servers, for development and tests. A test connects without a browser (`code: 'ok'`), and hooks make the fake app refuse a code, fail a renewal, withdraw a grant, offer several GitHub installations, or send a notice. It refuses `NODE_ENV=production` unless `productionSafe`.
