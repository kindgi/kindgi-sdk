// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The value a run answered, as it was sent: an agent's typed `output` when
 * it declares one, else its reply's content; a flow's output, whole. `run`
 * is a run as `GET /v1/runs/{runId}` answers it; an agent's run has `agent`.
 */
export function pickedAnswer(run: {
  readonly output?: unknown;
  readonly agent?: unknown;
}): unknown {
  const output = run.output as
    | { response?: { content?: unknown }; output?: unknown }
    | null
    | undefined;
  if (output === undefined || output === null) return undefined;
  if (run.agent === undefined) return output;
  if (output.output !== undefined && output.output !== null) return output.output;
  return output.response?.content;
}

/**
 * An answer as both places show it: a typed answer often arrives as JSON
 * text, so an object or array (bare, or in one ``` or ```json fence, as
 * models often write it) is read as its value. The text is trimmed for the
 * check; anything else comes back as it was sent.
 */
export function answerOfText(content: unknown): unknown {
  if (typeof content !== 'string') return content;
  const text = content.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text);
  const body = fenced?.[1] ?? text;
  if (!body.startsWith('{') && !body.startsWith('[')) return content;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return content;
  }
}

/** What a run answered: an agent's typed output, else its reply's text; a flow's output. Then `answerOfText`. */
export function answerValue(run: { readonly output?: unknown; readonly agent?: unknown }): unknown {
  return answerOfText(pickedAnswer(run));
}
