---
"@kindgi/sdk": patch
---

The providers skill says the in-process ONNX path (Path C) runs only with the runtime from source on macOS or a glibc Linux. It doesn't load in the runtime image, so it doesn't run under `kindgi dev`; local users go to Ollama.
