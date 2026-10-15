---
"@kindgi/tools": patch
---

**An HTTP tool's response body is read under the call's deadline, its cancel, and a size cap.**
- **The deadline and the cancel cover the body:** `timeoutMs` (30 s by default) runs until the body is read, not just until the headers arrive, and so does the run's cancel. A server that answers at once and then trickles its body fails the call as timed out, and the body's connection is closed.
- **A size cap,** counted as fetch decodes the body (so a small gzip download that expands past the cap is refused too). Reading stops at the cap, and the call fails, naming it. The default is 10 MiB.
- **`ToolSpecSynthesizerOptions.maxResponseBytes?`** (optional) sets the cap for the handlers a host synthesizes (`defineTool(spec, { synthesizer: { maxResponseBytes } })`). A value that isn't a positive whole number is refused when the tool is built.
- **A failed call's message** still quotes the start of its body (512 characters), and reads at most 2 KiB of it.
