---
"@kindgi/cli": patch
"@kindgi/sdk": patch
---

A coding agent and `kindgi dev`'s sandbox now stay out of a self-hosted deployment's `db.env` (its database's password) and `openfga.env` (OpenFGA's database address and key), as they already did `kindgi.env` and `pack.env`. `kindgi init` writes both into the deny rules for Claude Code and the other agents' ignore files, and the getting-started skills name them. A project set up before keeps its rules: add the two lines as the coding agents page shows.
