---
"@kindgi/cli": patch
---

**`kindgi dev` says what stopped it and what to do when something around it refuses what it needs. A coding agent's sandbox is a common cause, and then the fix is to run it in your own terminal.**
- Docker: a `docker` that can't be started (`spawn docker EPERM`), a socket that refuses the process, and an engine that doesn't answer each get their own message, in `kindgi dev`, `kindgi doctor` and `kindgi auth registry`. `kindgi dev` no longer tries to pull the runtime image when Docker can't be reached, and doesn't suggest installing Docker or another Postgres for a Docker that's there.
- When no port on `127.0.0.1` is allowed (`listen EPERM`), it says so instead of reading every port as in use, and the same for a pack service that can't listen.
- A file or folder `kindgi dev` can't write (`EROFS`, `EACCES`, `EPERM`) is named, with the code, instead of the system's bare error.
- A `docker logs` that can't start while the runtime boots no longer stops `kindgi dev`.
