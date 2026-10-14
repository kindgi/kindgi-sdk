---
"@kindgi/cli": patch
---

**When something around it stops what `kindgi dev` needs, it says what, and what to do: often a coding agent's sandbox, and then the person's own terminal.**
- Docker: a `docker` that can't be started (`spawn docker EPERM`), a socket that refuses the process, and an engine that doesn't answer each get their own message, in `kindgi dev`, `kindgi doctor` and `kindgi auth registry`. `kindgi dev` no longer tries to pull the runtime image when Docker can't be reached, and doesn't suggest installing Docker or another Postgres for a Docker that's there.
- A port on `127.0.0.1` that can't be had at all (`listen EPERM`) is said as such, rather than every port reading as in use; so is a pack service that can't listen.
- A file or folder `kindgi dev` can't write (`EROFS`, `EACCES`, `EPERM`): its path and the code, instead of the system's bare error.
- A `docker logs` that can't start while the runtime boots no longer ends the CLI.
