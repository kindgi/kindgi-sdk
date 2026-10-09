---
"@kindgi/dotenv-file": patch
"@kindgi/cli": patch
---

`KEY=${KEY}` in a pack's env file takes the shell's value, as a docker-compose `.env` does. A key that referred to itself was read as a cycle and expanded to `""`, so `ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}` gave the runtime an empty key, and the first model call failed. Now a self-reference takes the environment's value (`expandEnv`'s `env`), as both `dotenv-expand` 10 and 12 do; only a longer loop (`A=${B}`, `B=${A}`) is a cycle. A self-reference the environment doesn't have is empty, and `kindgi dev` and `kindgi env list` say so: "`ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}` takes the environment's ANTHROPIC_API_KEY, and the environment doesn't have it".

**Behaviour change:** under `kindgi dev`, the pack service's environment now takes the shell's value for every `${NAME}` the env files refer to without defining, as the runtime's already did. It used to expand them to `""`. Nothing else from the shell reaches it.
