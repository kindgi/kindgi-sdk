---
"@kindgi/api": patch
"@kindgi/platform": patch
---

Adding a team member names a person of the tenant, as adding a project member does.
- **`POST /v1/teams/{teamId}/memberships`:** someone who isn't a person of this tenant, was removed from it, or is named by an id that isn't one, is refused with 404 `identity-user-not-found`, and nothing is added. Before, a well-formed id the tenant doesn't have was added as a member, and a malformed one could fail with a 500 on a runtime's database.
- **`teamsRouter`** takes the identity directory (`createApp` passes `identityDirectory`, as it does to `projectsRouter`). Without a directory, an id is taken as given.
- **`TeamProjectGrant.grantedAt`** says it's also absent for a grant from before 0.1.6.
