---
"@kindgi/cli": patch
---

**`kindgi auth registry` logs in to Kindgi's registry, `registry.kindgi.com`, with your license key.** The username there is `kindgi`, so it takes no `--username`, and the hidden prompt asks for the license key.
- **`--key-from <store>`** reads the key from where it's kept, as `kindgi license renew` does: `file:…`, `env-file:…#NAME`, `gcp:…`, `azure:…` or `aws:…`. So a deployment's own key logs in without passing through your shell. It's for `registry.kindgi.com` only, and doesn't go with `--password-stdin` or `--check`.
- **A value that isn't a license key at all** (a key starts with `kgi_lk_`) is refused before anything logs in, and isn't shown. Whether a key pulls is the registry's to say.
- **The hints** in `kindgi auth registry`, `kindgi dev` and `kindgi doctor` name the license key, not a robot, when the image is on `registry.kindgi.com`.
- **Another registry**, such as a mirror, still takes `--username` and its own token.
