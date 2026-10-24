---
"@kindgi/api": patch
---

**A deployment's `endpoint` is described as absent when it ships nothing a pack service serves.** The OpenAPI description of `DeploymentEndpoint`, the `Deployment.endpoint` doc and the Python client's model now say that a deployment with no tool, and no guardrail check but built-in ones (a pack of agents and flows only), carries no `endpoint` when the server routes pack calls per deployment: it needs no pack service. No shape changes.
