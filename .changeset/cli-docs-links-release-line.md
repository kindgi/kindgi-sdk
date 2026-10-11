---
"@kindgi/cli": patch
"@kindgi/client": patch
---

**Docs links name their release line.**
- `kindgi sso providers start` now prints its "Step by step" guide at `https://docs.kindgi.com/v0.1/guides/sso/<guide>/`, not the docs' root. The root moves on to the next release line's docs, and during a release candidate it still shows the last release's. The skills `kindgi init` installs already link this way.
- **`@kindgi/client`:** the new `docsUrl(path, version?)` builds `docs.kindgi.com/v<major>.<minor>/<path>` for a Kindgi version, or the root without one. It has no dependencies, and `@kindgi/client/sso-handoff` re-exports it.
- **`identityProviderHandoff(urls, preset?, { version })`:** the handoff takes the version whose docs its `guideUrl` names. The CLI passes its own, and a console can pass the runtime's. Without a version the link is the root, as before.
- `SSO_GUIDES` is gone; `docsUrl` replaces it.
- `check:refs` now fails a root docs link in anything a package or SDK ships from its `src/`, as it already did for skills.
