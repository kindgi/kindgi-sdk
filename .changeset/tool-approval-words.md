---
"@kindgi/tools": patch
"@kindgi/specs": patch
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/handler-runtime": patch
"@kindgi/cli": patch
"@kindgi/sdk": patch
---

**A tool can say how an approval of a call to it reads: `approval`.** A tool manifest's new optional `approval: { title, summary?, about?: { kind, id } }` gives the words a reviewer reads a call in, such as `'Refund {amount} on order #{orderId}'`. Each `{field}` names a required top-level field of the input whose type is a string, a number, an integer or a boolean (or an enum of those):
- `defineTool`, `POST /v1/tools` and a deployment refuse any other, naming the tool and the text, as they refuse a `needsSpec` that doesn't compile;
- a call's values fill them in as plain text, on one line, cut when long;
- the approval keeps the words in its `context` (`context.text`, `context.about`), beside the call's arguments.

An approval of a tool call is now titled `Approve a call to <tool id>`, where it read `HITL review: <tool id>`. The title goes out in the reviewer's mail and the `approval.requested` event, which never carry a call's arguments, so it never holds the tool's words. The pack index carries `approval`, and `GET /v1/tools` shows it. The WooCommerce starter's four tools that change the store declare one each.
