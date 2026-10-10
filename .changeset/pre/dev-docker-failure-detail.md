---
"@kindgi/cli": patch
---

When `kindgi dev` can't pull or start the runtime image, it says why. It printed the last five lines of docker's output, and when docker had pulled first those were the pull's progress (`e3649207a629: Pull complete`, `Digest: …`), with the error cut off or buried among them. Now a pull's progress and docker's "Run 'docker run --help'" line are left out, so the message is docker's own error: `docker run failed: docker: cannot overwrite digest sha256:…`, an auth error or a full disk.
