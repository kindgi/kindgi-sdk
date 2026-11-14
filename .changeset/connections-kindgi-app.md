---
"@kindgi/connections": patch
"@kindgi/connections-inmemory": patch
---

**Facebook Pages and Instagram have entries, connected through Kindgi's own Meta app.** `@kindgi/connections/facebook-pages` (`facebookPages`) and `@kindgi/connections/instagram` (`instagram`) are the company's connections: a tenant admin connects one, with no app to register at Meta or in the workspace. Each asks for its own permissions, and an Instagram connection's token can't post on the business's Pages: `posts.write` and `pages.read` on Facebook Pages, `posts.write` and `account.read` on Instagram.

- **A sign-in kind for Kindgi's own app.** `SignIn` gains `{ kind: 'kindgi-app' }`: the connect goes through Kindgi's connect step, which holds the app's secret, so the sign-in takes no other field. Its account is `AccountLookup`'s new `{ kind: 'kindgi-app-account', asset: 'page' | 'instagram' }`, one of the Pages or accounts the admin shared.
- **`defineApp` checks it.** A `kindgi-app-account` needs a `kindgi-app` sign-in and an asset of the set, a `kindgi-app` sign-in takes no field besides its kind, `removal.notices` isn't for one (what Kindgi's app hears goes to Kindgi's connect step), and its only owner is the company.
- **The in-memory connections refuse such an entry** when they're made, since their fake app signs in only as an OAuth app or a GitHub App.
- **Docs.** "Facebook Pages" and "Instagram" say how an admin connects and disconnects, and where a business removes Kindgi at Meta; the connections overview, "Use a connection in a tool", "Add an app" and "How connections work" name them.
