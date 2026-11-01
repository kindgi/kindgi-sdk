# Clients other than Claude Code

`.mcp.json` at the pack root is what Claude Code reads natively. Other
clients read from their own paths (`.cursor/mcp.json`, `.vscode/mcp.json`,
Claude Desktop's system-wide config). To bridge:

1. Establish a symlink from the client's expected path to `.mcp.json`:
   ```sh
   mkdir -p .cursor && ln -sfn ../.mcp.json .cursor/mcp.json
   ```
2. Restart the client.

Symlinks work because the FILE CONTENTS are portable across every MCP
client — the `mcpServers` block has the same shape everywhere. Only
the file LOCATION differs. Edits to `.mcp.json` flow through
automatically via the symlink; no re-sync needed.

Windows users without dev-drive symlinks: `cp .mcp.json .cursor/mcp.json`,
and re-copy after every `kindgi mcp` edit.
