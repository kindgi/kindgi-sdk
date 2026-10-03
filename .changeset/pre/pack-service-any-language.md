---
"@kindgi/handler-runtime": minor
---

Pack code in any language.

- `createPackServiceSupervisor` takes `command` — the child's argv — instead of `entrypoint`, `nodeBinary` and `nodeArgs`: `[process.execPath, <pack-service-main>]` for this package's service, `[python, '-m', 'kindgi.pack', 'serve']` for the Python SDK's.
- A pack's config may be the `[tool.kindgi]` table of its `pyproject.toml` (same keys as `kindgi.config.*`): a Python pack. `KindgiConfig.language` (`'node' | 'python'`), `packLanguage`, `findKindgiConfig`, `PYPROJECT_FILENAME`, `DEFAULT_PYTHON_DISCOVERY`; `resolveDiscovery` takes the language. `runIndexer` refuses a Python pack with `language-mismatch`.
