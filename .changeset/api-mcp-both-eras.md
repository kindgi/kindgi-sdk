---
"@kindgi/api": patch
---

**`/mcp` serves both MCP eras on purpose, and its access line says which revision each request spoke.** The endpoint answers 2026-07-28 requests per request and the 2025 revisions' `initialize` statelessly, now as an explicit choice rather than the library's default: the chat apps still open with `initialize`. Each `/mcp` access line carries `mcpProtocolVersion` (the `MCP-Protocol-Version` header's date as sent, else `none` or `other`), on the unsigned first request too, and, once signed in, `mcpEra` (`legacy` or `modern`, by the library's own classification). Neither field carries the body, a tool name or a token. `/mcp` lines stay at `debug`.
