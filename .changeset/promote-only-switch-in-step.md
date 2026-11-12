---
"@kindgi/api": patch
"@kindgi/platform": patch
---

A promote-only build deployed at the same moment as its project goes into production is refused on one side, whichever lands second, with no change on the wire. `POST /v1/deployments` asks whether a build is promote-only on every deploy, not only on one into a project in production, and registers such a build with `promoteOnly: true`. `DeploymentBinding.register` takes that field and may answer `project-in-production`: a binding that keeps projects in the same store reads the project in the registration's own step, and records nothing when it's in production or isn't there. `ProjectBinding.setProduction` may answer `promote-only-build`, with the deployment's id and the id of the key that signed it: a binding that keeps deployments in the same store reads them in its own step. Both routes answer these as their own checks do, `409 promote-only-build` with the same words and details. `makeInMemoryProjectBinding` takes `promoteOnlyDeployment`, read in `setProduction`'s step. A binding that never answers either works as before. Asking on every deploy reads the trust list once for a build whose own fields don't mark it.
