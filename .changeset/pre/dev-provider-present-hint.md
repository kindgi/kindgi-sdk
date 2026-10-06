---
"@kindgi/cli": patch
---

**`kindgi dev` names the `unregister` for every declared provider it leaves.** When a provider with a declared id is registered already, but not by `kindgi dev`, it is still left as it is. Each such line now names the `kindgi providers unregister <id>` that lets the config's version apply. Before, only a provider with another region or models got that hint (the ⚠ line). The runtime lists a provider's metadata, not its adapter, the adapter's settings or the key's name. So a provider registered by hand against another endpoint, with the config's models, looked the same and got no hint. The line now says those can't be compared.
