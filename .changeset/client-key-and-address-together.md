---
"@kindgi/sdk": patch
---

`createClient()` takes the API's URL and token from the running `kindgi dev` together, or not at all. With `KINDGI_API_TOKEN` set (or `auth` passed) and no URL, it no longer sends that token to the URL in the nearest `.kindgirc.json`: it throws, naming the file and what to set. With `KINDGI_API_URL` set (or `apiUrl` passed) and no token, it takes the file's token only when the URL is the file's own, and throws the same way for another URL. Set both in your env file, or neither to use the running `kindgi dev`.
