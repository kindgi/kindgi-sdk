---
"@kindgi/connections": patch
---

**LinkedIn (posts as a person):** the `linkedin` entry at `@kindgi/connections/linkedin`, for a member's own profile on a company's own LinkedIn app with the two self-serve products (no LinkedIn review), and `linkedinPost` at `@kindgi/connections/linkedin/tools`, included under the id its pack names.
- The entry signs in with OAuth 2.0 and PKCE, asks for `w_member_social` (in plain words: post, comment and react on LinkedIn as you), and learns whose profile it is from OpenID Connect's userinfo (`sub`, labelled with the name; the email isn't asked for). LinkedIn has no revoke for one app's tokens and gives refresh tokens only to partners it approves, so a connection asks its person to connect again after LinkedIn's 60 days. Calls are paced at LinkedIn's 150 a day per member.
- `linkedinPost` posts text of up to 3,000 characters to the person's own feed, seen by anyone or by their connections only, and gives the post's id and link. The text is posted as written: LinkedIn's markup is escaped, so a post mentions no one, and a `#` that starts a word stays a hashtag. It's `mutating`: in a run no person started, each post waits for that person's yes, and a step run again gets the first post's answer.
