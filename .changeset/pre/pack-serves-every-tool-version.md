---
"@kindgi/handler-runtime": patch
---

A pack can hold several versions of one tool, side by side: one agent version may pin `acme.scorer@1.0.0` while another pins `2.0.0`. The pack service (TypeScript and Python) keys its tools by id and version: a call runs the version it names; a call that names none runs the tool's only version, and is refused (`tool-version-mismatch`, naming the versions it has) when there are several. `GET /v1/info` lists every version. The Python indexer accepts several versions of one id, keyed by the version the index records (a tool without its own takes the pack's), and refuses the same version twice.
