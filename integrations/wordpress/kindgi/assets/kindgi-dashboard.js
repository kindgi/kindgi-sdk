// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Kindgi box on the WordPress dashboard (`Kindgi_Dashboard::box`):
 * what waits for the person, the first of it named, and what the agents
 * did last. Opening the dashboard signs no one in at Kindgi: without a
 * live session the box keeps the count it was drawn with, and asks Kindgi
 * when the person says to. Text from Kindgi or WordPress is only ever set
 * as text, never as HTML.
 */
(() => {
  const root = document.getElementById('kindgi-dashboard-app');
  if (root === null) return;
  const live = root.querySelector('.kindgi-dash-live');
  const { __, _n, sprintf } = wp.i18n;
  const { api, el, notice, loading, muted, timeEl, runState } = window.kindgiCards;
  const urls = window.kindgiConfig?.urls ?? {};
  // The count the box was drawn with: it stays while Kindgi isn't asked.
  const drawn = live.querySelector('.kindgi-dash-waits');

  /** "2 approvals wait for you", linked to the Inbox; "Nothing waits for you." when none does. */
  function waitsLine(answer) {
    if (answer.count === 0) {
      return el('p', { className: 'kindgi-dash-waits' }, __('Nothing waits for you.', 'kindgi'));
    }
    const number = answer.more ? `${answer.count}+` : String(answer.count);
    return el(
      'p',
      { className: 'kindgi-dash-waits' },
      el(
        'a',
        { href: urls.inbox },
        sprintf(
          /* translators: %s: how many, such as 3 or 12+ */
          _n('%s approval waits for you', '%s approvals wait for you', answer.count, 'kindgi'),
          number,
        ),
      ),
    );
  }

  /** The approvals that wait for the person, oldest first, each opening its card in the Inbox. */
  const waitingList = (waiting) =>
    waiting.length === 0
      ? null
      : el(
          'ul',
          { className: 'kindgi-dash-list', role: 'list' },
          waiting.map((a) =>
            el(
              'li',
              {},
              el('a', { href: `${urls.inbox}&approval=${encodeURIComponent(a.id)}` }, a.heading),
              el('span', { className: 'kindgi-muted' }, ' · ', timeEl(a.createdAt)),
            ),
          ),
        );

  /** One run: its agent or flow, its state, its first line, and when. */
  const runRow = (run) =>
    el(
      'li',
      { className: 'kindgi-dash-run' },
      el(
        'div',
        { className: 'kindgi-run-head' },
        el('strong', {}, run.name || __('A run', 'kindgi')),
        runState(run),
      ),
      run.summary ? el('p', { className: 'kindgi-dash-summary' }, run.summary) : null,
      el('span', { className: 'kindgi-muted' }, timeEl(run.createdAt)),
    );

  /** What the agents did last, with the way to all of it. */
  const latest = (runs) =>
    el(
      'div',
      { className: 'kindgi-dash-latest' },
      el('h3', {}, __('Latest', 'kindgi')),
      runs.length === 0
        ? muted(__('Nothing yet: what the agents do shows here.', 'kindgi'))
        : el('ul', { className: 'kindgi-dash-list', role: 'list' }, runs.map(runRow)),
      el('p', {}, el('a', { href: urls.activity }, __('All activity', 'kindgi'))),
    );

  /** Without a live session: the count as drawn, and the way to ask Kindgi. */
  const notAsked = () => [
    drawn ?? '',
    muted(
      __(
        "Opening the dashboard doesn't sign you in to Kindgi, so this box hasn't asked it.",
        'kindgi',
      ),
    ),
    el(
      'p',
      {},
      el(
        'button',
        { type: 'button', className: 'button', onclick: () => show(true) },
        __('Show what Kindgi has', 'kindgi'),
      ),
    ),
  ];

  /** The box, from the person's live session; with `signIn`, signed in first if they have none. */
  async function show(signIn = false) {
    live.replaceChildren(loading(2));
    let answer;
    try {
      answer = await api(`/dashboard${signIn ? '?signIn=true' : ''}`);
    } catch (error) {
      live.replaceChildren(notice(error, () => show(signIn)));
      return;
    }
    if (!answer.signedIn) {
      live.replaceChildren(...notAsked());
      return;
    }
    live.replaceChildren(
      el('div', {}, waitsLine(answer), waitingList(answer.waiting)),
      latest(answer.runs),
    );
    // The menu's count and the admin bar's follow what the box just read.
    document.dispatchEvent(
      new CustomEvent('kindgi-count', {
        detail: { n: answer.count, more: answer.more, orders: null },
      }),
    );
  }

  show();
})();
