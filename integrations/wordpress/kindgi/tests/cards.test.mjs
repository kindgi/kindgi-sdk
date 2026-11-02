// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An approval's card (`assets/kindgi-cards.js`), as a person decides it:
 * what its buttons say, and what it says once Kindgi has recorded the
 * decision; and a conversation's steps: whether each call ran, and why
 * one didn't. The script runs as WordPress loads it, against small
 * stand-ins for the page's elements and `wp`; the cards are as the
 * plugin's routes answer them (`Kindgi_Inbox::card`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));

/** An element, as far as the cards use one. */
class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.childNodes = [];
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    this.append(...nodes);
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.childNodes = this.parentNode.childNodes.filter((node) => node !== this);
    }
  }

  setAttribute(key, value) {
    this.attributes[key] = String(value);
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  focus() {}

  querySelectorAll(tagName) {
    return within(this).filter((node) => node.tagName === tagName);
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('');
  }
}

/** A node and every node under it. */
const within = (node) => [node, ...(node.childNodes ?? []).flatMap(within)];

/** `%s` and `%1$s`, as WordPress's `sprintf` fills them. */
function sprintf(format, ...values) {
  let next = 0;
  return format.replace(/%(?:(\d+)\$)?s/g, (_, at) => String(values[at ? Number(at) - 1 : next++]));
}

/**
 * The card script, loaded on a page with no Kindgi config. Each decision
 * it sends is kept, and answered with `answer`.
 */
function loadCards(answer) {
  const sent = [];
  const window = {};
  runInNewContext(readFileSync(join(here, '../assets/kindgi-cards.js'), 'utf8'), {
    window,
    document: {
      createElement: (tagName) => new Element(tagName),
      createTextNode: (text) => ({ textContent: text }),
    },
    wp: {
      i18n: { __: (text) => text, _n: (one, more, n) => (n === 1 ? one : more), sprintf },
      apiFetch: async (options) => {
        sent.push(options);
        return answer;
      },
      date: {
        dateI18n: () => 'November 1, 2026 5:40 am',
        getSettings: () => ({ formats: { datetime: 'F j, Y g:i a' } }),
        humanTimeDiff: () => '3 hours ago',
      },
    },
    setTimeout,
  });
  return { cards: window.kindgiCards, sent };
}

/** A tool call waiting for the person, with the given fields changed. */
const toolCall = (changes = {}) => ({
  id: 'ap-1',
  heading: 'Refund large',
  summary: '',
  facts: [{ label: 'Order ID', value: '18' }],
  words: [],
  reply: null,
  whole: null,
  status: 'pending',
  createdAt: '2026-11-01T05:40:00Z',
  expiresAt: null,
  next: null,
  asked: { kind: 'none', name: null },
  agent: 'Support desk',
  pin: null,
  waitsFor: 'you',
  notYours: null,
  conversationId: null,
  opens: false,
  about: null,
  decision: null,
  ...changes,
});

const reply = toolCall({
  heading: 'Reply to pat@example.com',
  facts: [],
  words: [{ label: 'The reply', text: 'Hi Pat, your order ships on Monday.' }],
  reply: { to: 'pat@example.com' },
});

const pin = toolCall({
  id: 'ap-pin',
  heading: 'Update Ceramics help to version 0.1.2',
  facts: [],
  agent: null,
  pin: { agent: 'Ceramics help', version: '0.1.2', segment: null },
});

/** Kindgi's answer to a decision: the card decided by the person, and what it did to a run. */
const answered = (card, decision, run) => ({
  approval: {
    ...card,
    status: decision === 'reject' ? 'rejected' : 'approved',
    waitsFor: null,
    decision: {
      decision,
      decidedAt: '2026-11-02T02:30:00Z',
      reason: decision === 'reject' ? 'Not yet.' : null,
      byMe: true,
      by: null,
    },
  },
  ...run,
});

const button = (node, label) =>
  within(node).find((n) => n.tagName === 'button' && n.textContent === label);

/** Wait for a decision's answer to show. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Reject a card with a reason, through its two buttons. */
async function reject(node, ask, confirm) {
  button(node, ask).listeners.click();
  within(node).find((n) => n.tagName === 'textarea').value = 'Not yet.';
  button(node, confirm).listeners.click();
  await settled();
}

test('a reply that is not sent says so once Kindgi records it', async () => {
  const { cards, sent } = loadCards(
    answered(reply, 'reject', { waitpointResolved: true, runStatus: null }),
  );
  const node = cards.approvalCard(reply);
  await reject(node, "Don't send…", "Don't send");
  // Made in the script's own realm: compared by its fields.
  assert.deepEqual({ ...sent[0].data }, { decision: 'reject', reason: 'Not yet.' });
  assert.match(node.textContent, /Rejected by you, 3 hours ago: Not yet\./);
  assert.match(
    node.textContent,
    /Not sent\. If the agent writes a new reply, it comes to the Inbox\./,
  );
});

test('a new version of an agent reads as an update, asked from Kindgi', () => {
  const { cards } = loadCards(null);
  const node = cards.approvalCard(pin);
  assert.match(node.textContent, /^Update Ceramics help to version 0\.1\.2/);
  assert.match(node.textContent, /Asked from Kindgi · 3 hours ago/);
  assert.ok(button(node, 'Approve the update'));
  button(node, "Don't update…").listeners.click();
  assert.match(
    node.textContent,
    /Ceramics help keeps the version it runs now\. Whoever asked sees it too\./,
  );
});

test('an approved update says what Kindgi does next: no run waits on it', async () => {
  const { cards } = loadCards(
    answered(pin, 'approve', { waitpointResolved: false, runStatus: null }),
  );
  const node = cards.approvalCard(pin);
  button(node, 'Approve the update').listeners.click();
  await settled();
  assert.match(node.textContent, /Approved by you, 3 hours ago/);
  assert.match(node.textContent, /Kindgi updates it if nothing changed since it was asked for\./);
  assert.doesNotMatch(node.textContent, /moved on/);
});

test('a rejected update says the agent keeps its version', async () => {
  const { cards } = loadCards(
    answered(pin, 'reject', { waitpointResolved: false, runStatus: null }),
  );
  const node = cards.approvalCard(pin);
  await reject(node, "Don't update…", "Don't update");
  assert.match(node.textContent, /Not updated: Ceramics help keeps the version it runs now\./);
  assert.doesNotMatch(node.textContent, /moved on/);
});

test('a decision on a run that had already ended says so', async () => {
  const card = toolCall();
  const { cards } = loadCards(
    answered(card, 'approve', { waitpointResolved: false, runStatus: 'cancelled' }),
  );
  const node = cards.approvalCard(card);
  button(node, 'Approve').listeners.click();
  await settled();
  assert.match(node.textContent, /The run had already moved on \(cancelled\)\./);
});

/** A step's words, as plain fields: made in the script's own realm. */
const stepOf = (cards, ...args) => ({ ...cards.stepWords(...args) });

test("a step whose call has no answer yet doesn't say the tool was used", () => {
  const { cards } = loadCards(null);
  assert.deepEqual(stepOf(cards, 'acme.reply'), {
    ran: false,
    line: 'Asked to use Reply',
    why: null,
  });
});

test("a call Kindgi didn't allow says so, and why", () => {
  const { cards } = loadCards(null);
  const result = { status: 'denied', reason: " You don't have permission to use the tool. " };
  assert.deepEqual(stepOf(cards, 'woo.find-orders', { result }), {
    ran: false,
    line: "Couldn't use Find orders",
    why: "You don't have permission to use the tool.",
  });
});

test('a call its connections stopped, or that failed, says so, and why', () => {
  const { cards } = loadCards(null);
  const missing = {
    status: 'failed',
    error: {
      code: 'connection-missing',
      connection: 'mail',
      message: "Mail needs connecting before this call can run, so it didn't run.",
    },
  };
  assert.deepEqual(stepOf(cards, 'acme.reply', { result: missing }), {
    ran: false,
    line: "Couldn't use Reply",
    why: "Mail needs connecting before this call can run, so it didn't run.",
  });
  for (const [error, why] of [
    [
      { kind: 'tool-error', message: 'The order service timed out. ' },
      'The order service timed out.',
    ],
    [
      { kind: 'invalid-arguments', message: 'orderId: expected a number.', issues: [] },
      'orderId: expected a number.',
    ],
  ]) {
    const failed = {
      kindgi: 'tool-error-retry',
      status: 'failed',
      error,
      instruction: 'Call it again.',
    };
    assert.deepEqual(stepOf(cards, 'woo.find-orders', { result: failed }), {
      ran: false,
      line: "Couldn't use Find orders",
      why,
    });
  }
});

/** Guardrails' note on a call (Kindgi's `callNote`): their ids, what it says of the call, their reasons, the model's next step. */
const note = (ids, said, reasons) =>
  [
    `[kindgi:guardrail-retry] ${JSON.stringify(ids)}`,
    said,
    ...reasons,
    "Don't make this call again as it is. Go on without it.",
  ].join('\n');

test('a call guardrails stopped says so, with their reasons', () => {
  const { cards } = loadCards(null);
  const one = note(['big-refunds'], "This call didn't run: it didn't pass this guardrail.", [
    '- big-refunds: Refunds over 100 need a person.',
  ]);
  assert.deepEqual(stepOf(cards, 'woo.refund-large', { result: one }), {
    ran: false,
    line: "Couldn't use Refund large: a guardrail stopped it",
    why: '- big-refunds: Refunds over 100 need a person.',
  });
  const two = note(
    ['big-refunds', 'no-weekend'],
    "This call didn't run: it didn't pass these guardrails.",
    ['- big-refunds: Refunds over 100 need a person.', "- no-weekend: the call didn't pass it"],
  );
  assert.deepEqual(stepOf(cards, 'woo.refund-large', { result: two }), {
    ran: false,
    line: "Couldn't use Refund large: guardrails stopped it",
    why: "- big-refunds: Refunds over 100 need a person.\n- no-weekend: the call didn't pass it",
  });
});

test('a call whose approval was rejected says so, with the reason when one was given', () => {
  const { cards } = loadCards(null);
  assert.deepEqual(
    stepOf(cards, 'woo.refund-large', { result: { status: 'rejected', rationale: 'Not yet.' } }),
    {
      ran: false,
      line: "Didn't use Refund large: its approval was rejected",
      why: 'Reason: Not yet.',
    },
  );
  assert.deepEqual(stepOf(cards, 'woo.refund-large', { result: { status: 'rejected' } }), {
    ran: false,
    line: "Didn't use Refund large: its approval was rejected",
    why: null,
  });
});

test("a tool's own answer reads as used, whatever its fields", () => {
  const { cards } = loadCards(null);
  for (const result of [
    { status: 'denied', reason: 'Card declined.', orderId: 18 },
    { status: 'rejected', by: 'bank' },
    { status: 'failed', error: { code: 'card-declined', message: 'Card declined.' } },
    { status: 'failed', error: 'Card declined.' },
    {
      kindgi: 'retry',
      status: 'failed',
      error: { message: 'Card declined.' },
      instruction: 'Again.',
    },
    // Guardrails' note on a call that ran, its result withheld.
    note(['pii'], "This call ran, but its result is withheld: it didn't pass this guardrail.", [
      '- pii: It names a person.',
    ]),
    '[kindgi:guardrail-retry] ["pii"]',
    "[kindgi:guardrail-retry] not ids\nThis call didn't run: it didn't pass this guardrail.\nDon't make this call again.",
    { orders: [] },
    [],
    'done',
    null,
  ]) {
    assert.deepEqual(stepOf(cards, 'woo.find-orders', { result }), {
      ran: true,
      line: 'Used Find orders',
      why: null,
    });
  }
});
