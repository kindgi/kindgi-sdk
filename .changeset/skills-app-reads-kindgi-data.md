---
"@kindgi/sdk": patch
---

The getting-started skills (TypeScript and Python) say how an app reads what a run did: it stores the run's id on its own row and reads the status, output, journal and provenance through the API, hearing about finished runs from the `run.finished` webhook. They also say what not to do: query Kindgi's database, or send users to Kindgi's console.
