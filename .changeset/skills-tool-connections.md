---
"@kindgi/sdk": patch
---

**The tool-authoring skills cover connections to other apps,** in TypeScript, Python, Java and Scala. A tool declares the connection it needs in its `needsSpec`, reads the call's short-lived token from the call's context, and throws a refusal with the connection's name when the app answers 401. The TypeScript skill also points at the ready-made Gmail, Outlook, GitHub and LinkedIn tools in `@kindgi/connections`, each included under an id the pack names, and at `appFetch` for a tool's own calls to an app's API.
