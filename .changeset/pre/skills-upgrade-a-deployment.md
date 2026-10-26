---
"@kindgi/sdk": patch
---

**The getting-started skills (TypeScript, Python, Java, Scala) say how to upgrade a self-hosted deployment,** and load for it. There's no migration script: the runtime brings its database up to date when it starts. A small dev deployment on Cloud Run, on runtime 0.1.8 or later, upgrades with the Cloud Run module's `./upgrade.sh`, from the tag of the release it's upgrading to, `--dry-run` first; the skills link the module README's Upgrading section for the rest. Any other Cloud Run deployment, or one on Azure Container Apps, follows its page's "Operate it" section, and anything else the operate page's upgrade steps. The Java and Scala skills add that `./kindgiw upgrade` moves the pack's own pins, not a deployment's runtime.
