---
"@kindgi/cli": patch
---

**`kindgi dev` warns when `--database-url` has a password, which `ps` shows to other users on the machine, and its help says to keep the URL in `.kindgi/secrets.env`.** The warning names no part of the URL, and `kindgi dev` goes on. A `KINDGI_DATABASE_URL` from the shell or the env files is on no command line, so it gets no warning. `--dev-token`'s help says the same of the token: once pinned, it's kept in `.kindgirc.json`, so later runs need no flag.
