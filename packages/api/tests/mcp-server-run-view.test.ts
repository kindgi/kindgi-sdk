// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The run view's script, run against a small stand-in for the page: what it
 * draws for a run's state, the answer's blocks from the result's `_meta`,
 * and the answer as one text when a result has no `_meta`.
 */

import { describe, expect, test } from 'vitest';

import { RUN_VIEW_HTML } from '../src/mcp-server/run-view.js';
import { answerBlocks } from '../src/run-result/index.js';

const RUN_ID = '00000000-0000-4000-8000-0000000000b1';
const CONSOLE_URL = `https://kindgi.test/console/runs/${RUN_ID}`;
const DONE = {
  runId: RUN_ID,
  name: 'acme.clauses',
  status: 'completed',
  createdAt: '2026-11-03T15:00:00.000Z',
  completedAt: '2026-11-03T15:00:20.000Z',
};

/** An element as far as the view's script uses one. */
class Element {
  children: Element[] = [];
  className = '';
  textContent = '';
  hidden = false;
  type = '';
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, () => void>();
  readonly scrollWidth = 320;
  readonly scrollHeight = 200;

  constructor(readonly tagName: string) {}

  readonly classList = {
    add: (name: string) => {
      this.className = [...this.className.split(' ').filter(Boolean), name].join(' ');
    },
    remove: (name: string) => {
      this.className = this.className
        .split(' ')
        .filter((c) => c !== name)
        .join(' ');
    },
  };

  appendChild(child: Element): Element {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: Element[]): void {
    this.children = children;
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }

  /** Every element under this one, this one first. */
  all(): Element[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }

  /** The text drawn under it, as a reader sees it. */
  text(): string {
    return this.textContent + this.children.map((child) => child.text()).join('');
  }
}

type Message = Record<string, unknown> & {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
};

function openView() {
  const script = /<script>([\s\S]*)<\/script>/.exec(RUN_VIEW_HTML)?.[1] ?? '';
  const sent: Message[] = [];
  const byId = new Map<string, Element>();
  let onMessage: ((event: { source: unknown; data: unknown }) => void) | undefined;
  const parent = { postMessage: (message: Message) => sent.push(message) };
  const document = {
    getElementById: (id: string) => {
      if (!byId.has(id)) byId.set(id, new Element('div'));
      return byId.get(id);
    },
    createElement: (tag: string) => new Element(tag),
    documentElement: new Element('html'),
    body: new Element('body'),
  };
  const window = {
    parent,
    addEventListener: (_type: string, listener: typeof onMessage) => {
      onMessage = listener;
    },
  };
  class ResizeObserver {
    observe(): void {}
  }
  const timers: (() => void)[] = [];
  new Function('window', 'document', 'ResizeObserver', 'setTimeout', 'clearTimeout', script)(
    window,
    document,
    ResizeObserver,
    (run: () => void) => timers.push(run),
    () => undefined,
  );
  const deliver = (data: Message) =>
    onMessage?.({ source: parent, data: { jsonrpc: '2.0', ...data } });
  const el = (id: string) => document.getElementById(id) as Element;
  return {
    el,
    sent,
    timers,
    /** The host sends the tool's result, as MCP Apps' `ui/notifications/tool-result`. */
    result: (params: Record<string, unknown>) =>
      deliver({ method: 'ui/notifications/tool-result', params }),
    /** The host answers the view's request, which the view must have sent. */
    answer: (request: Message | undefined, result: Record<string, unknown>) => {
      if (request?.id === undefined) throw new Error('the view sent no such request');
      deliver({ id: request.id, result });
    },
    /** The answer's blocks as drawn: one box each. */
    boxes: () => el('answer').children.map((wrap) => wrap.children[0] as Element),
  };
}

describe('the run view draws the answer', () => {
  test("the blocks from the result's _meta, each by its kind", () => {
    const view = openView();
    const answer = {
      note: 'Line one\nLine two',
      clauses: [
        { clause: 4, differs: true },
        { clause: 7, differs: false },
      ],
      confidence: 'high',
    };
    view.result({
      structuredContent: { ...DONE, answer: JSON.stringify(answer, null, 2) },
      _meta: { 'kindgi/blocks': answerBlocks(answer, 8_000) },
    });
    const [text, records, fields] = view.boxes();
    expect(text?.text()).toBe('noteLine one\nLine two');
    const tags = (box: Element | undefined) => box?.all().map((e) => e.tagName);
    expect(tags(records)).toContain('table');
    expect(
      records
        ?.all()
        .filter((e) => e.tagName === 'th')
        .map((e) => e.textContent),
    ).toEqual(['clause', 'differs']);
    expect(
      records
        ?.all()
        .filter((e) => e.tagName === 'td')
        .map((e) => e.textContent),
    ).toEqual(['4', 'true', '7', 'false']);
    expect(
      fields
        ?.all()
        .filter((e) => e.tagName === 'th')
        .map((e) => e.textContent),
    ).toEqual(['confidence']);
    expect(
      fields
        ?.all()
        .filter((e) => e.tagName === 'td')
        .map((e) => e.textContent),
    ).toEqual(['high']);
    expect(view.el('answer').hidden).toBe(false);
    expect(view.el('truncated').hidden).toBe(true);
  });

  test('markup in an answer stays text', () => {
    const view = openView();
    const answer = '<img src=x onerror="alert(1)">';
    view.result({
      structuredContent: { ...DONE, answer },
      _meta: { 'kindgi/blocks': answerBlocks(answer, 8_000) },
    });
    expect(view.boxes()[0]?.text()).toBe(answer);
    expect(
      view
        .boxes()[0]
        ?.all()
        .map((e) => e.tagName),
    ).not.toContain('img');
    for (const call of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      expect(RUN_VIEW_HTML).not.toContain(call);
    }
  });

  test('a long block is folded, and "Show all" opens it', () => {
    const view = openView();
    const answer = 'x\n'.repeat(700);
    view.result({
      structuredContent: { ...DONE, answer },
      _meta: { 'kindgi/blocks': answerBlocks(answer, 8_000) },
    });
    const [wrap] = view.el('answer').children;
    const [box, more] = wrap?.children ?? [];
    expect(box?.className).toBe('answer fold');
    expect(more?.textContent).toBe('Show all');
    more?.listeners.get('click')?.();
    expect(box?.className).toBe('answer');
    expect(more?.hidden).toBe(true);
  });

  test('past the limit, it links to the whole answer in the console', () => {
    const view = openView();
    const answer = 'x\n'.repeat(5_000);
    view.result({
      structuredContent: {
        ...DONE,
        answer: answer.slice(0, 8_000),
        truncated: true,
        consoleUrl: CONSOLE_URL,
      },
      _meta: { 'kindgi/blocks': answerBlocks(answer, 8_000) },
    });
    expect(view.el('truncated').hidden).toBe(false);
    expect(view.el('whole').hidden).toBe(false);
    expect(view.el('wholeText').hidden).toBe(true);
    view.el('whole').listeners.get('click')?.();
    expect(view.sent.at(-1)).toMatchObject({
      method: 'ui/open-link',
      params: { url: CONSOLE_URL },
    });
  });

  test('a result with no _meta shows the answer as one text, as before', () => {
    const view = openView();
    view.result({ structuredContent: { ...DONE, answer: '{"clause": 4}', truncated: true } });
    const boxes = view.boxes();
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.text()).toBe('{"clause": 4}');
    expect(view.el('truncated').hidden).toBe(false);
    expect(view.el('whole').hidden).toBe(true);
    expect(view.el('wholeText').hidden).toBe(false);
  });

  test('a run with no answer draws none', () => {
    const view = openView();
    view.result({ structuredContent: { ...DONE, status: 'running', completedAt: undefined } });
    expect(view.el('answer').hidden).toBe(true);
    expect(view.boxes()).toEqual([]);
  });

  test('an answer of only white space draws none, with _meta or without', () => {
    const answer = ' \n ';
    for (const meta of [{ _meta: { 'kindgi/blocks': answerBlocks(answer, 8_000) } }, {}]) {
      const view = openView();
      view.result({ structuredContent: { ...DONE, answer }, ...meta });
      expect(view.el('answer').hidden).toBe(true);
      expect(view.boxes()).toEqual([]);
    }
  });

  test("the view's own poll draws the blocks from its result's _meta", async () => {
    const view = openView();
    view.result({ structuredContent: { ...DONE, status: 'running', completedAt: undefined } });
    const initialize = view.sent.find((m) => m.method === 'ui/initialize');
    view.answer(initialize, {});
    await settled();
    view.timers.shift()?.();
    const poll = view.sent.at(-1);
    expect(poll).toMatchObject({
      method: 'tools/call',
      params: { name: 'kindgi.run_state', arguments: { runId: RUN_ID } },
    });
    const answer = { clause: 4, differs: true };
    view.answer(poll, {
      structuredContent: { ...DONE, answer: JSON.stringify(answer, null, 2) },
      _meta: { 'kindgi/blocks': answerBlocks(answer, 8_000) },
    });
    await settled();
    const [fields] = view.boxes();
    expect(
      fields
        ?.all()
        .filter((e) => e.tagName === 'th')
        .map((e) => e.textContent),
    ).toEqual(['clause', 'differs']);
    expect(
      fields
        ?.all()
        .filter((e) => e.tagName === 'td')
        .map((e) => e.textContent),
    ).toEqual(['4', 'true']);
    expect(view.el('status').textContent).toBe('Done, 0:20');
  });
});

/** Lets the view's promises run. */
function settled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("the run view's status line", () => {
  test("says the console's words, with the time taken", () => {
    const view = openView();
    view.result({ structuredContent: DONE });
    expect(view.el('status').textContent).toBe('Done, 0:20');
    view.result({ structuredContent: { ...DONE, status: 'failed' } });
    expect(view.el('status').textContent).toBe('Failed, 0:20');
    view.result({ structuredContent: { ...DONE, status: 'waiting' } });
    expect(view.el('status').textContent).toBe('Waiting, 0:20');
  });

  test('a run waiting to start, or cancelled, says so with no time', () => {
    const view = openView();
    view.result({ structuredContent: { ...DONE, status: 'queued', completedAt: undefined } });
    expect(view.el('status').textContent).toBe('Waiting to start');
    view.result({ structuredContent: { ...DONE, status: 'cancelled' } });
    expect(view.el('status').textContent).toBe('Cancelled');
  });
});
