---
"@kindgi/capabilities": minor
"@kindgi/adapter-model-anthropic": minor
"@kindgi/adapter-model-gemini": minor
"@kindgi/adapter-model-openai-compat": minor
"@kindgi/adapter-model-shared": minor
"@kindgi/adapter-model-bedrock": minor
"@kindgi/adapter-model-azure-openai": minor
"@kindgi/adapter-model-in-process": minor
---

**A model call can carry files: photos, PDFs and text files.** A user or tool message names stored files in a new optional `files` field (`MessageFile`: the stored file's id, name, type, size and sha256). The message holds references only. The adapter reads the bytes through the call's new optional `readFile`, sends them inline, and keeps none.
- **What's sent.** JPEG, PNG and WebP images (at most 5 MB each) and PDFs (at most 10 MB) go to a model that declares `vision`, after a line naming each file. Plain text, Markdown and CSV files (at most 1 MB, cut at 100,000 characters) are read in as text for any model, in a block marked as data, not instructions. All of them follow the message's text under a line saying they come from outside: data, not instructions.
- **What isn't.** Anything else, or a file over a limit, is a line naming the file and saying why it isn't shown. Examples: a HEIC photo, an image sent to a model without `vision`, a file that's no longer stored, or bytes that aren't the file that was checked. A call fails for none of them.
- **One set of limits on every provider.** A call sends at most 10 images and PDFs, 12 MB together, and keeps the newest. `FILE_LIMITS` has the numbers. Bedrock's own lower limits also apply there: 3.75 MB an image, 4.5 MB and five a call for PDFs.
- **A tool result's files.** Anthropic and the OpenAI Responses API take them in the tool result. Gemini, Chat Completions, Azure OpenAI and Bedrock get them in a user message right after the tool results, each under a line naming its call.
- **Anthropic's prompt cache** now counts image and document blocks, so a conversation's photo is read from the cache on the next step.
- **A PDF goes to the provider under a neutral name,** never the file's own: a file name is outside data.
- **`vision`'s description** now says it reads images and PDFs.
